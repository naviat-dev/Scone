# Scone Scenery Conversion Guide

Scone turns Microsoft Flight Simulator (MSFS) scenery packages into addons that can be used in FlightGear. This README focuses on the conversion workflow—what you need, how to prepare scenery, how to run a conversion, and what files to expect afterward.

## 1. What You Need

- **Scenery source folder** containing the `scenery` subdirectory MSFS ships (BGLs, textures, etc.). If you extracted a package, point Scone at the folder that contains the `*.bgl` files.
- **Output directory** with enough free space for meshes and copied DDS textures.
- **Scone build** for your OS (download from the Releases tab or build locally using `dotnet publish`).

## 2. Prepare the Scenery Folder

1. Copy the scenery package you want to convert into a working location (e.g., `~/scenery/MyAirport/`).
2. Ensure both **placement BGLs** (with scenery object placements) and **model BGLs** live under the same root; Scone reads every `*.bgl` it finds.
3. If textures sit outside the package root, create a `Textures` (or similar) folder under the same root so Scone can find them while exporting.

## 3. Launch Scone & Configure Output

1. Start the app (`dotnet run --project Scone/Scone.csproj` or double-click the packaged binary).
2. Click **Settings** (top-right) and set your preferred output folder. This becomes the base path for every conversion job.
3. Close the settings dialog; the main dashboard lists active conversions.

## 4. Create a Conversion Task

1. Hit the **+** floating button.
2. **Scenery Folder Path** – browse to the root folder you prepared.
3. **Task Name** – optional; defaults to the folder name.
4. **Output Format** – toggle **glTF** and/or **AC3D**. You can export both simultaneously.
5. Click **Add Task** to queue it.

Tasks appear as cards showing status, current step, and cancellation options.

## 5. Monitor the Conversion

Scone processes each BGL twice:

1. **Placement pass** – records every `LibraryObject` placement and determines which tiles need exports.
2. **Model pass** – pulls each GUID’s model, converts the embedded GLB, and merges it into per-tile scenes.

During conversion, the task card shows log snippets (e.g., “Processing GLBD chunk for model …”). You can:

- **Cancel & Save Progress** – stop after finishing the current tile and keep produced output.
- **Cancel Entirely** – abort immediately without writing more files.

## 6. Output Layout

Each tile ends up under `Objects/<lonBucket>/<latBucket>/<lon>/<lat>/`. Inside that folder you’ll see:

| File | Description |
| ------ | ------------- |
| `<tile>.gltf/.glb` | Exported glTF scene (if glTF enabled). Textures referenced beside it. |
| `<tile>.ac` | AC3D world with deduplicated vertices, corrected normals, and MSFS coordinate adjustments (if AC3D enabled). |
| `<tile>.xml` | ***Diabled currently:*** Only when both formats are produced: references both models and adds rotate/select animations so FlightGear or other sims can choose formats. |
| `<tile>.stg` | Placement entry referencing `.gltf`, `.ac`, or `.xml` plus the tile center coordinates. |
| `*.dds` textures | Copied base color, metallic/roughness, normal, occlusion, and emissive textures discovered during conversion. |

## 7. Format-Specific Tips

### glTF / GLB

- glTF files are lighter and support PBR materials natively, but are only usable in the nightly builds of FlightGear. More data from the original scenery pack is preserved in glTF exports.

### AC3D

- AC3D files are generally heavier and do not natively support PBR materials, but they are usable in both the latest and nightly builds of FlightGear. While Scone attempts to map PBR materials to AC3D’s simpler format, some visual fidelity may be lost and material mismatches can occur.

## 8. Troubleshooting Checklist

- **“No models found”** – verify the scenery folder actually contains model BGLs (look for `modellib.BGL` equivalents). Scone now searches case-insensitively, but the files must still exist.
- **Textures missing in exports** – ensure the source folder contains the referenced DDS files. Scone logs each missing texture in the console/terminal.
- **AC3D looks mirrored** – check that you’re viewing with a left-handed coordinate system. The exporter already mirrors to match Blender; no manual flips should be required.
- **Large exports stall** – conversions run per tile; if a huge tile appears stuck, watch the log for progress. Use “Cancel & Save” to stop after the current tile, then re-run with a smaller scenery subset.

## 9. Getting the App

- **Download** – grab the latest release artifact (`scone-<platform>-<arch>.zip`) from the GitHub Releases page.
- **Build yourself** – clone the repo and run `dotnet publish Scone/Scone.csproj -c Release -r <RID>`. The published folder contains the executable and assets.

Happy converting! Open an issue if you hit problems or have ideas to streamline the workflow further.
