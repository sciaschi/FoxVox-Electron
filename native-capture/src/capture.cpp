// native-capture/src/capture.cpp
//
// DXGI Desktop Duplication -> double-buffered SharedArrayBuffer
// with native-side downscale to a target resolution.
//
// Optimized for two common cases:
//   1) target == desktop size: fast row-copy, no software rescale
//   2) target < desktop size: software nearest-neighbor downscale before JS ever sees the frame

#include <napi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <cstring>
#include <string>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

using Microsoft::WRL::ComPtr;

struct FrameHeader {
    static constexpr size_t OFFSET_WIDTH            = 0;
    static constexpr size_t OFFSET_HEIGHT           = 4;
    static constexpr size_t OFFSET_WRITE_SLOT       = 8;
    static constexpr size_t OFFSET_RESERVED         = 12;

    static constexpr size_t OFFSET_SLOT0_TIMESTAMP  = 16;
    static constexpr size_t OFFSET_SLOT0_FRAME_IDX  = 24;
    static constexpr size_t OFFSET_SLOT0_READY      = 28;

    static constexpr size_t OFFSET_SLOT1_TIMESTAMP  = 32;
    static constexpr size_t OFFSET_SLOT1_FRAME_IDX  = 40;
    static constexpr size_t OFFSET_SLOT1_READY      = 44;

    static constexpr size_t HEADER_SIZE             = 48;
};

static ComPtr<ID3D11Device>           g_device;
static ComPtr<ID3D11DeviceContext>    g_context;
static ComPtr<IDXGIOutputDuplication> g_duplication;
static ComPtr<ID3D11Texture2D>        g_stagingTex;

static std::atomic<bool> g_running{false};
static std::thread       g_captureThread;

static uint32_t g_outputWidth   = 0;
static uint32_t g_outputHeight  = 0;
static uint32_t g_targetWidth   = 0;
static uint32_t g_targetHeight  = 0;

static uint8_t* g_sharedPtr     = nullptr;
static size_t   g_sharedSize    = 0;

static size_t GetSlotBytes() {
    if (g_sharedSize <= FrameHeader::HEADER_SIZE)
        return 0;

    return (g_sharedSize - FrameHeader::HEADER_SIZE) / 2;
}

static uint8_t* GetSlotBase(uint32_t slot) {
    const size_t slotBytes = GetSlotBytes();
    if (!g_sharedPtr || slot > 1 || slotBytes == 0)
        return nullptr;

    return g_sharedPtr + FrameHeader::HEADER_SIZE + (slot * slotBytes);
}

bool InitDXGI(int adapterIndex, int outputIndex) {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
        return false;

    ComPtr<IDXGIAdapter1> adapter;
    if (FAILED(factory->EnumAdapters1(adapterIndex, &adapter)))
        return false;

    D3D_FEATURE_LEVEL featureLevel;
    if (FAILED(D3D11CreateDevice(
        adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
        nullptr, 0, D3D11_SDK_VERSION,
        &g_device, &featureLevel, &g_context)))
        return false;

    ComPtr<IDXGIOutput> output;
    if (FAILED(adapter->EnumOutputs(outputIndex, &output)))
        return false;

    ComPtr<IDXGIOutput1> output1;
    if (FAILED(output.As(&output1)))
        return false;

    if (FAILED(output1->DuplicateOutput(g_device.Get(), &g_duplication)))
        return false;

    DXGI_OUTPUT_DESC desc;
    output->GetDesc(&desc);

    g_outputWidth  = desc.DesktopCoordinates.right  - desc.DesktopCoordinates.left;
    g_outputHeight = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;

    if (g_targetWidth == 0)  g_targetWidth = g_outputWidth;
    if (g_targetHeight == 0) g_targetHeight = g_outputHeight;

    D3D11_TEXTURE2D_DESC texDesc = {};
    texDesc.Width            = g_outputWidth;
    texDesc.Height           = g_outputHeight;
    texDesc.MipLevels        = 1;
    texDesc.ArraySize        = 1;
    texDesc.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    texDesc.SampleDesc.Count = 1;
    texDesc.Usage            = D3D11_USAGE_STAGING;
    texDesc.CPUAccessFlags   = D3D11_CPU_ACCESS_READ;

    if (FAILED(g_device->CreateTexture2D(&texDesc, nullptr, &g_stagingTex)))
        return false;

    return true;
}

static void WriteScaledFrameToShared(
    const uint8_t* src,
    uint32_t srcRowPitch,
    uint64_t timestamp,
    uint32_t frameIndex
) {
    if (!g_sharedPtr || !g_sharedSize)
        return;

    const uint32_t dstW = g_targetWidth;
    const uint32_t dstH = g_targetHeight;

    const size_t slotBytes = GetSlotBytes();
    const size_t pixelBytes = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 4;

    if (slotBytes == 0 || pixelBytes > slotBytes)
        return;

    const uint32_t slot = frameIndex & 1u;
    uint8_t* dst = GetSlotBase(slot);
    if (!dst)
        return;

    // Fast path: no resize needed, just row-copy into the selected slot.
    if (dstW == g_outputWidth && dstH == g_outputHeight) {
        const uint32_t rowBytes = dstW * 4;
        for (uint32_t y = 0; y < dstH; ++y) {
            memcpy(dst + static_cast<size_t>(y) * rowBytes,
                   src + static_cast<size_t>(y) * srcRowPitch,
                   rowBytes);
        }
    } else {
        // Resize path: nearest-neighbor downscale before JS sees the frame.
        const float scaleX = static_cast<float>(g_outputWidth)  / static_cast<float>(dstW);
        const float scaleY = static_cast<float>(g_outputHeight) / static_cast<float>(dstH);

        for (uint32_t y = 0; y < dstH; ++y) {
            const uint32_t srcY = static_cast<uint32_t>(y * scaleY);
            const uint8_t* srcRow = src + static_cast<size_t>(srcY) * srcRowPitch;
            uint8_t* dstRow = dst + static_cast<size_t>(y) * dstW * 4;

            for (uint32_t x = 0; x < dstW; ++x) {
                const uint32_t srcX = static_cast<uint32_t>(x * scaleX);
                const uint8_t* srcPx = srcRow + static_cast<size_t>(srcX) * 4;
                uint8_t* dstPx = dstRow + static_cast<size_t>(x) * 4;

                dstPx[0] = srcPx[0];
                dstPx[1] = srcPx[1];
                dstPx[2] = srcPx[2];
                dstPx[3] = srcPx[3];
            }
        }
    }

    uint8_t* base = g_sharedPtr;

    auto writeU32 = [base](size_t offset, uint32_t val) {
        memcpy(base + offset, &val, 4);
    };
    auto writeU64 = [base](size_t offset, uint64_t val) {
        memcpy(base + offset, &val, 8);
    };

    writeU32(FrameHeader::OFFSET_WIDTH,  dstW);
    writeU32(FrameHeader::OFFSET_HEIGHT, dstH);

    if (slot == 0) {
        writeU64(FrameHeader::OFFSET_SLOT0_TIMESTAMP, timestamp);
        writeU32(FrameHeader::OFFSET_SLOT0_FRAME_IDX, frameIndex);
        writeU32(FrameHeader::OFFSET_SLOT0_READY, 1);
    } else {
        writeU64(FrameHeader::OFFSET_SLOT1_TIMESTAMP, timestamp);
        writeU32(FrameHeader::OFFSET_SLOT1_FRAME_IDX, frameIndex);
        writeU32(FrameHeader::OFFSET_SLOT1_READY, 1);
    }

    std::atomic_thread_fence(std::memory_order_release);
    writeU32(FrameHeader::OFFSET_WRITE_SLOT, slot);
}

void CaptureLoop(int targetFps) {
    auto frameDuration = std::chrono::microseconds(1000000 / targetFps);
    uint32_t frameIndex = 0;

    while (g_running.load()) {
        auto frameStart = std::chrono::steady_clock::now();

        ComPtr<IDXGIResource> desktopResource;
        DXGI_OUTDUPL_FRAME_INFO frameInfo;
        HRESULT hr = g_duplication->AcquireNextFrame(16, &frameInfo, &desktopResource);

        if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
            auto elapsed = std::chrono::steady_clock::now() - frameStart;
            auto remaining = frameDuration - elapsed;
            if (remaining.count() > 0)
                std::this_thread::sleep_for(remaining);
            continue;
        }

        if (FAILED(hr)) {
            g_running.store(false);
            break;
        }

        ComPtr<ID3D11Texture2D> desktopTex;
        desktopResource.As(&desktopTex);

        g_context->CopyResource(g_stagingTex.Get(), desktopTex.Get());

        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = g_context->Map(g_stagingTex.Get(), 0, D3D11_MAP_READ, 0, &mapped);

        if (SUCCEEDED(hr)) {
            uint64_t timestamp = std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now().time_since_epoch()
            ).count();

            WriteScaledFrameToShared(
                static_cast<const uint8_t*>(mapped.pData),
                mapped.RowPitch,
                timestamp,
                frameIndex++
            );

            g_context->Unmap(g_stagingTex.Get(), 0);
        }

        g_duplication->ReleaseFrame();

        auto elapsed = std::chrono::steady_clock::now() - frameStart;
        auto remaining = frameDuration - elapsed;
        if (remaining.count() > 0)
            std::this_thread::sleep_for(remaining);
    }
}

Napi::Value AttachBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1) {
        Napi::Error::New(env, "Expected Uint8Array").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info[0].IsTypedArray()) {
        auto arr = info[0].As<Napi::TypedArray>();
        auto ab  = arr.ArrayBuffer();
        g_sharedPtr  = static_cast<uint8_t*>(ab.Data()) + arr.ByteOffset();
        g_sharedSize = arr.ByteLength();
    } else if (info[0].IsArrayBuffer()) {
        auto ab = info[0].As<Napi::ArrayBuffer>();
        g_sharedPtr  = static_cast<uint8_t*>(ab.Data());
        g_sharedSize = ab.ByteLength();
    } else {
        Napi::Error::New(env, "Expected Uint8Array or ArrayBuffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (g_sharedSize >= FrameHeader::HEADER_SIZE)
        memset(g_sharedPtr, 0, FrameHeader::HEADER_SIZE);

    return Napi::Boolean::New(env, true);
}

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    int adapterIndex = 0;
    int outputIndex = 0;
    int fps = 30;
    g_targetWidth = 0;
    g_targetHeight = 0;

    if (info.Length() > 0 && info[0].IsObject()) {
        auto opts = info[0].As<Napi::Object>();
        if (opts.Has("adapterIndex"))
            adapterIndex = opts.Get("adapterIndex").As<Napi::Number>().Int32Value();
        if (opts.Has("outputIndex"))
            outputIndex = opts.Get("outputIndex").As<Napi::Number>().Int32Value();
        if (opts.Has("fps"))
            fps = opts.Get("fps").As<Napi::Number>().Int32Value();
        if (opts.Has("targetWidth"))
            g_targetWidth = opts.Get("targetWidth").As<Napi::Number>().Uint32Value();
        if (opts.Has("targetHeight"))
            g_targetHeight = opts.Get("targetHeight").As<Napi::Number>().Uint32Value();
    }

    if (g_running.load()) {
        Napi::Error::New(env, "Capture already running").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    if (g_captureThread.joinable())
        g_captureThread.join();

    g_duplication.Reset();
    g_stagingTex.Reset();
    g_context.Reset();
    g_device.Reset();

    if (!g_sharedPtr || g_sharedSize == 0) {
        Napi::Error::New(env, "Call attachBuffer() first").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    if (!InitDXGI(adapterIndex, outputIndex)) {
        Napi::Error::New(env, "DXGI initialization failed").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    const size_t slotBytes = GetSlotBytes();
    const size_t requiredBytes =
        static_cast<size_t>(g_targetWidth) *
        static_cast<size_t>(g_targetHeight) * 4;

    if (slotBytes < requiredBytes) {
        std::string msg =
            "Shared buffer slot too small for target resolution. slotBytes=" + std::to_string(slotBytes) +
            ", requiredBytes=" + std::to_string(requiredBytes) +
            ", target=" + std::to_string(g_targetWidth) + "x" + std::to_string(g_targetHeight);

        Napi::Error::New(env, msg).ThrowAsJavaScriptException();
        g_duplication.Reset();
        g_stagingTex.Reset();
        g_context.Reset();
        g_device.Reset();
        return Napi::Boolean::New(env, false);
    }

    g_running.store(true);

    try {
        g_captureThread = std::thread(CaptureLoop, fps);
    } catch (const std::exception& ex) {
        g_running.store(false);
        g_duplication.Reset();
        g_stagingTex.Reset();
        g_context.Reset();
        g_device.Reset();

        Napi::Error::New(env, std::string("Failed to start capture thread: ") + ex.what())
            .ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    g_running.store(false);

    if (g_captureThread.joinable())
        g_captureThread.join();

    g_duplication.Reset();
    g_stagingTex.Reset();
    g_context.Reset();
    g_device.Reset();

    g_outputWidth = 0;
    g_outputHeight = 0;
    g_targetWidth = 0;
    g_targetHeight = 0;

    return info.Env().Undefined();
}

Napi::Value GetInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto result = Napi::Object::New(env);

    result.Set("width", Napi::Number::New(env, g_targetWidth));
    result.Set("height", Napi::Number::New(env, g_targetHeight));
    result.Set("outputWidth", Napi::Number::New(env, g_outputWidth));
    result.Set("outputHeight", Napi::Number::New(env, g_outputHeight));
    result.Set("running", Napi::Boolean::New(env, g_running.load()));
    result.Set("bufferSize", Napi::Number::New(env, static_cast<double>(g_sharedSize)));
    result.Set("slotBytes", Napi::Number::New(env, static_cast<double>(GetSlotBytes())));

    return result;
}

Napi::Value RequiredBufferSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    uint32_t w = 1920;
    uint32_t h = 1080;
    if (info.Length() >= 2) {
        w = info[0].As<Napi::Number>().Uint32Value();
        h = info[1].As<Napi::Number>().Uint32Value();
    }

    const size_t slotBytes = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
    const size_t size = FrameHeader::HEADER_SIZE + (slotBytes * 2);

    return Napi::Number::New(env, static_cast<double>(size));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("attachBuffer",       Napi::Function::New(env, AttachBuffer));
    exports.Set("startCapture",       Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture",        Napi::Function::New(env, StopCapture));
    exports.Set("getInfo",            Napi::Function::New(env, GetInfo));
    exports.Set("requiredBufferSize", Napi::Function::New(env, RequiredBufferSize));
    exports.Set("buildTag",           Napi::String::New(env, "cpu-optimized-1080p-v1"));

    auto header = Napi::Object::New(env);
    header.Set("OFFSET_WIDTH",           Napi::Number::New(env, FrameHeader::OFFSET_WIDTH));
    header.Set("OFFSET_HEIGHT",          Napi::Number::New(env, FrameHeader::OFFSET_HEIGHT));
    header.Set("OFFSET_WRITE_SLOT",      Napi::Number::New(env, FrameHeader::OFFSET_WRITE_SLOT));
    header.Set("OFFSET_RESERVED",        Napi::Number::New(env, FrameHeader::OFFSET_RESERVED));
    header.Set("OFFSET_SLOT0_TIMESTAMP", Napi::Number::New(env, FrameHeader::OFFSET_SLOT0_TIMESTAMP));
    header.Set("OFFSET_SLOT0_FRAME_IDX", Napi::Number::New(env, FrameHeader::OFFSET_SLOT0_FRAME_IDX));
    header.Set("OFFSET_SLOT0_READY",     Napi::Number::New(env, FrameHeader::OFFSET_SLOT0_READY));
    header.Set("OFFSET_SLOT1_TIMESTAMP", Napi::Number::New(env, FrameHeader::OFFSET_SLOT1_TIMESTAMP));
    header.Set("OFFSET_SLOT1_FRAME_IDX", Napi::Number::New(env, FrameHeader::OFFSET_SLOT1_FRAME_IDX));
    header.Set("OFFSET_SLOT1_READY",     Napi::Number::New(env, FrameHeader::OFFSET_SLOT1_READY));
    header.Set("HEADER_SIZE",            Napi::Number::New(env, FrameHeader::HEADER_SIZE));
    exports.Set("FrameHeader", header);

    return exports;
}

NODE_API_MODULE(native_capture, Init)
