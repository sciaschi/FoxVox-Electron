{
  "targets": [
    {
      "target_name": "native_capture",
      "sources": [ "src/capture.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_CPP_EXCEPTIONS",
        "_WIN32_WINNT=0x0A00",
        "WINVER=0x0A00",
        "WINRT_LEAN_AND_MEAN",
        "NOMINMAX"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [
            "/std:c++20",
            "/EHsc",
            "/Zc:__cplusplus"
          ]
        },
        "VCLinkerTool": {
          "AdditionalDependencies": [
            "windowsapp.lib"
          ]
        }
      }
    }
  ]
}