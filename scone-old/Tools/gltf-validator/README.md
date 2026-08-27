# Bundled glTF Validator Binaries

Place prebuilt validator executables here, organized by OS (not architecture):

- `windows/gltf_validator.exe`
- `linux/gltf_validator`
- `macos/gltf_validator`

Notes:

- These files are copied into both build output and publish output by `Scone.csproj`.
- The same OS binary is reused across all RID variants for that OS.
- Ensure Unix binaries (`linux/gltf_validator`, `macos/gltf_validator`) have execute permission (`chmod +x`).
