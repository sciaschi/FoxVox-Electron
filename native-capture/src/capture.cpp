#include <napi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <cstring>
#include <vector>
#include <mmsystem.h>
#include <windows.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "windowsapp.lib")

using Microsoft::WRL::ComPtr;
namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd11 = winrt::Windows::Graphics::DirectX::Direct3D11;

struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")) IDirect3DDxgiInterfaceAccess : ::IUnknown {
    virtual HRESULT __stdcall GetInterface(GUID const& id, void** object) = 0;
};

#pragma pack(push, 1)
struct FrameHeader {
    uint32_t width, height, writeSlot, reserved;
    uint64_t slot0Timestamp; uint32_t slot0FrameIdx, slot0Ready;
    uint64_t slot1Timestamp; uint32_t slot1FrameIdx, slot1Ready;
    static constexpr size_t HEADER_SIZE = 48;
};
#pragma pack(pop)

static ComPtr<ID3D11Device>           g_device;
static ComPtr<ID3D11DeviceContext>    g_context;
static ComPtr<IDXGIOutputDuplication> g_duplication;
static ComPtr<ID3D11Texture2D>        g_stagingTex[3];
static std::atomic<bool>              g_running{ false };
static std::thread                    g_captureThread;
static std::atomic<uint32_t>          g_targetWidth{ 0 }, g_targetHeight{ 0 };
static uint32_t                       g_stagingWidth = 0, g_stagingHeight = 0;
static uint8_t*                       g_sharedPtr  = nullptr;
static size_t                         g_sharedSize = 0;
static std::vector<uint32_t>          g_xOffsets, g_yOffsets;
static std::vector<uint8_t>           g_rowBuffer;
static wgc::Direct3D11CaptureFramePool g_wgcFramePool{ nullptr };
static wgc::GraphicsCaptureSession     g_wgcSession{ nullptr };
static wgd11::IDirect3DDevice          g_winrtDevice{ nullptr };

template <typename T>
static winrt::com_ptr<T> GetDXGIInterfaceFromObject(winrt::Windows::Foundation::IInspectable const& object) {
    auto access = object.as<IDirect3DDxgiInterfaceAccess>();
    winrt::com_ptr<T> result;
    winrt::check_hresult(access->GetInterface(winrt::guid_of<T>(), result.put_void()));
    return result;
}

static void ResetCaptureState() {
    g_running.store(false);
    if (g_captureThread.joinable()) g_captureThread.join();
    if (g_wgcSession) { try { g_wgcSession.Close(); } catch(...) {} g_wgcSession = nullptr; }
    if (g_wgcFramePool) { try { g_wgcFramePool.Close(); } catch(...) {} g_wgcFramePool = nullptr; }
    g_duplication.Reset();
    for (auto& tex : g_stagingTex) tex.Reset();
    g_winrtDevice = nullptr;
    g_context.Reset();
    g_device.Reset();
}

static bool CreateStagingTextures(uint32_t w, uint32_t h) {
    if (!g_device || w == 0 || h == 0) return false;
    g_stagingWidth = w; g_stagingHeight = h;
    g_xOffsets.clear(); g_yOffsets.clear(); // Clear offsets to trigger recalculation
    D3D11_TEXTURE2D_DESC d = {w, h, 1, 1, DXGI_FORMAT_B8G8R8A8_UNORM, {1,0}, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, 0};
    for (int i = 0; i < 3; ++i) {
        g_stagingTex[i].Reset();
        if (FAILED(g_device->CreateTexture2D(&d, nullptr, &g_stagingTex[i]))) return false;
    }
    return true;
}

static void WriteToShared(const uint8_t* src, uint32_t srcPitch, uint32_t fIdx) {
    if (!g_sharedPtr || !g_sharedSize) return;
    const uint32_t tw = g_targetWidth.load();
    const uint32_t th = g_targetHeight.load();
    const uint32_t slot = fIdx & 1u;
    const size_t sBytes = (g_sharedSize - 48) / 2;
    uint8_t* dst = g_sharedPtr + 48 + (slot * sBytes);

    if (tw == g_stagingWidth && th == g_stagingHeight) {
        const uint32_t rb = tw * 4;
        for (uint32_t y = 0; y < th; ++y) memcpy(dst + (size_t)y * rb, src + (size_t)y * srcPitch, rb);
    } else {
        if (g_xOffsets.size() != tw) {
            g_xOffsets.resize(tw); float sx = (float)g_stagingWidth / tw;
            for (uint32_t x = 0; x < tw; ++x) g_xOffsets[x] = (uint32_t)(x * sx) * 4;
        }
        if (g_yOffsets.size() != th) {
            g_yOffsets.resize(th); float sy = (float)g_stagingHeight / th;
            for (uint32_t y = 0; y < th; ++y) g_yOffsets[y] = (uint32_t)(y * sy);
        }
        if (g_rowBuffer.size() < srcPitch) g_rowBuffer.resize(srcPitch);
        for (uint32_t y = 0; y < th; ++y) {
            memcpy(g_rowBuffer.data(), src + (size_t)g_yOffsets[y] * srcPitch, (size_t)g_stagingWidth * 4);
            uint32_t* dr = (uint32_t*)(dst + (size_t)y * tw * 4);
            for (uint32_t x = 0; x < tw; ++x) dr[x] = *(uint32_t*)(g_rowBuffer.data() + g_xOffsets[x]);
        }
    }
    FrameHeader* h = (FrameHeader*)g_sharedPtr;
    h->width = tw; h->height = th;
    if (slot == 0) { h->slot0FrameIdx = fIdx; std::atomic_thread_fence(std::memory_order_release); h->slot0Ready = 1; }
    else { h->slot1FrameIdx = fIdx; std::atomic_thread_fence(std::memory_order_release); h->slot1Ready = 1; }
    h->writeSlot = slot;
}

static void CaptureLoopDXGI(int fps) {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    timeBeginPeriod(1);
    uint32_t fIdx = 0, sIdx = 0, lastSIdx = 0;
    const auto interval = std::chrono::microseconds(1000000 / fps);

    // AcquireNextFrame's timeout must cover roughly a full frame interval,
    // not a tiny fixed window. Desktop compositor updates aren't synced to
    // our loop's timing, so a 2ms timeout very often misses a frame that
    // arrives a few ms later in the same tick - that previously didn't
    // matter because we always fell back to re-sending the last frame, but
    // now that we only write on a genuine new frame (see below), missing
    // the window here means we write nothing at all for that tick.
    const DWORD acquireTimeoutMs = (DWORD)std::max<int64_t>(
        1, std::chrono::duration_cast<std::chrono::milliseconds>(interval).count());

    auto nextTime = std::chrono::steady_clock::now();

    while (g_running.load()) {
        // Only true if THIS tick actually produced a new frame. Previously
        // "hasFrame" latched true forever after the first frame, so every
        // tick re-mapped and re-wrote the last staging texture even when
        // the desktop hadn't changed at all - wasted GPU readback + CPU
        // scale/copy on every idle frame.
        bool gotNewFrameThisTick = false;

        ComPtr<IDXGIResource> res;
        DXGI_OUTDUPL_FRAME_INFO info{};
        if (SUCCEEDED(g_duplication->AcquireNextFrame(acquireTimeoutMs, &info, &res))) {
            if (info.AccumulatedFrames > 0) {
                ComPtr<ID3D11Texture2D> tex;
                if (SUCCEEDED(res.As(&tex))) {
                    sIdx = (sIdx + 1) % 3;
                    g_context->CopyResource(g_stagingTex[sIdx].Get(), tex.Get());
                    lastSIdx = sIdx;
                    gotNewFrameThisTick = true;
                }
            }
            g_duplication->ReleaseFrame();
        }
        if (gotNewFrameThisTick) {
            D3D11_MAPPED_SUBRESOURCE m{};
            if (SUCCEEDED(g_context->Map(g_stagingTex[lastSIdx].Get(), 0, D3D11_MAP_READ, 0, &m))) {
                WriteToShared((const uint8_t*)m.pData, m.RowPitch, fIdx++);
                g_context->Unmap(g_stagingTex[lastSIdx].Get(), 0);
            }
        }

        // AcquireNextFrame already blocked for most/all of the interval, so
        // only sleep the remainder if a frame came back quickly. Avoids
        // double-waiting a full interval on top of an already-blocking call.
        auto now = std::chrono::steady_clock::now();
        auto target = nextTime + interval;
        if (now < target) {
            std::this_thread::sleep_until(target);
            nextTime = target;
        } else {
            nextTime = now;
        }
    }
    timeEndPeriod(1);
}

static void CaptureLoopWGC(int fps) {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    uint32_t fIdx = 0, sIdx = 0, lastSIdx = 0;
    const auto interval = std::chrono::microseconds(1000000 / fps);
    auto nextTime = std::chrono::steady_clock::now();

    while (g_running.load()) {
        // Same fix as CaptureLoopDXGI: only Map/WriteToShared when this
        // tick actually pulled a new frame from the pool.
        bool gotNewFrameThisTick = false;

        try {
            auto frame = g_wgcFramePool.TryGetNextFrame();
            if (frame) {
                auto contentSize = frame.ContentSize();
                if ((uint32_t)contentSize.Width != g_stagingWidth || (uint32_t)contentSize.Height != g_stagingHeight) {
                    CreateStagingTextures(contentSize.Width, contentSize.Height);
                    g_wgcFramePool.Recreate(g_winrtDevice, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, contentSize);
                }
                auto tex = GetDXGIInterfaceFromObject<ID3D11Texture2D>(frame.Surface());
                if (tex) {
                    sIdx = (sIdx + 1) % 3;
                    g_context->CopyResource(g_stagingTex[sIdx].Get(), tex.get());
                    lastSIdx = sIdx;
                    gotNewFrameThisTick = true;
                }
            }
        } catch (...) { break; }

        if (gotNewFrameThisTick) {
            D3D11_MAPPED_SUBRESOURCE m{};
            if (SUCCEEDED(g_context->Map(g_stagingTex[lastSIdx].Get(), 0, D3D11_MAP_READ, 0, &m))) {
                WriteToShared((const uint8_t*)m.pData, m.RowPitch, fIdx++);
                g_context->Unmap(g_stagingTex[lastSIdx].Get(), 0);
            }
        }
        std::this_thread::sleep_until(nextTime += interval);
        if (std::chrono::steady_clock::now() > nextTime + interval) nextTime = std::chrono::steady_clock::now();
    }
}

Napi::Value StartDisplayCapture(const Napi::CallbackInfo& info) {
    Napi::Object o = info[0].As<Napi::Object>();
    ResetCaptureState();
    g_targetWidth = o.Get("targetWidth").As<Napi::Number>().Uint32Value();
    g_targetHeight = o.Get("targetHeight").As<Napi::Number>().Uint32Value();
    ComPtr<IDXGIFactory1> f; CreateDXGIFactory1(IID_PPV_ARGS(&f));
    ComPtr<IDXGIAdapter1> a; f->EnumAdapters1(o.Get("adapterIndex").As<Napi::Number>().Int32Value(), &a);
    D3D11CreateDevice(a.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &g_device, nullptr, &g_context);
    ComPtr<IDXGIOutput> out; a->EnumOutputs(o.Get("outputIndex").As<Napi::Number>().Int32Value(), &out);
    ComPtr<IDXGIOutput1> out1; out.As(&out1); out1->DuplicateOutput(g_device.Get(), &g_duplication);
    DXGI_OUTPUT_DESC d{}; out->GetDesc(&d);
    CreateStagingTextures(d.DesktopCoordinates.right - d.DesktopCoordinates.left, d.DesktopCoordinates.bottom - d.DesktopCoordinates.top);
    g_running = true;
    g_captureThread = std::thread(CaptureLoopDXGI, o.Get("fps").As<Napi::Number>().Int32Value());
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value StartWindowCapture(const Napi::CallbackInfo& info) {
    Napi::Object o = info[0].As<Napi::Object>();
    ResetCaptureState();
    g_targetWidth = o.Get("targetWidth").As<Napi::Number>().Uint32Value();
    g_targetHeight = o.Get("targetHeight").As<Napi::Number>().Uint32Value();
    D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &g_device, nullptr, &g_context);
    ComPtr<IDXGIDevice> dxgi; g_device.As(&dxgi);
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    winrt::com_ptr<::IInspectable> insp; CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), insp.put());
    g_winrtDevice = insp.as<wgd11::IDirect3DDevice>();
    auto factory = winrt::get_activation_factory<wgc::GraphicsCaptureItem>();
    winrt::com_ptr<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem> abiItem;
    factory.as<IGraphicsCaptureItemInterop>()->CreateForWindow((HWND)(uintptr_t)o.Get("hwnd").As<Napi::Number>().Int64Value(), winrt::guid_of<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem>(), abiItem.put_void());
    auto item = abiItem.as<wgc::GraphicsCaptureItem>();
    auto size = item.Size();
    CreateStagingTextures(size.Width, size.Height);
    g_wgcFramePool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(g_winrtDevice, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, size);
    g_wgcSession = g_wgcFramePool.CreateCaptureSession(item);
    try { g_wgcSession.IsCursorCaptureEnabled(true); } catch(...) {}
    try { g_wgcSession.IsBorderRequired(false); } catch(...) {}
    g_wgcSession.StartCapture();
    g_running = true;
    g_captureThread = std::thread(CaptureLoopWGC, o.Get("fps").As<Napi::Number>().Int32Value());
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("attachBuffer", Napi::Function::New(env, [](const Napi::CallbackInfo& info){
        auto arr = info[0].As<Napi::TypedArray>();
        g_sharedPtr = (uint8_t*)arr.ArrayBuffer().Data() + arr.ByteOffset();
        g_sharedSize = arr.ByteLength();
        if (g_sharedPtr) memset(g_sharedPtr, 0, 48);
        return info.Env().Undefined();
    }));
    exports.Set("startDisplayCapture", Napi::Function::New(env, StartDisplayCapture));
    exports.Set("startWindowCapture", Napi::Function::New(env, StartWindowCapture));
    exports.Set("stopCapture", Napi::Function::New(env, [](const Napi::CallbackInfo&){ ResetCaptureState(); }));
    exports.Set("requiredBufferSize", Napi::Function::New(env, [](const Napi::CallbackInfo& info){
        return Napi::Number::New(info.Env(), (double)(48 + (size_t)info[0].As<Napi::Number>().Uint32Value() * info[1].As<Napi::Number>().Uint32Value() * 8));
    }));
    exports.Set("getInfo", Napi::Function::New(env, [](const Napi::CallbackInfo& info){
        Napi::Object res = Napi::Object::New(info.Env());
        res.Set("running", g_running.load()); res.Set("width", (uint32_t)g_targetWidth.load()); res.Set("height", (uint32_t)g_targetHeight.load());
        return res;
    }));
    exports.Set("getCapabilities", Napi::Function::New(env, [](const Napi::CallbackInfo& info){
        Napi::Object c = Napi::Object::New(info.Env()); c.Set("dxgiDisplay", true); c.Set("wgcWindow", true); return c;
    }));
    Napi::Object h = Napi::Object::New(env);
    h.Set("OFFSET_WIDTH", 0.0); h.Set("OFFSET_HEIGHT", 4.0); h.Set("OFFSET_WRITE_SLOT", 8.0);
    h.Set("OFFSET_SLOT0_FRAME_IDX", 24.0); h.Set("OFFSET_SLOT0_READY", 28.0);
    h.Set("OFFSET_SLOT1_FRAME_IDX", 40.0); h.Set("OFFSET_SLOT1_READY", 44.0);
    h.Set("HEADER_SIZE", 48.0); exports.Set("FrameHeader", h);
    return exports;
}
NODE_API_MODULE(native_capture, Init)