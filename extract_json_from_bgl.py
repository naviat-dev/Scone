#!/usr/bin/env python3
"""
Extract JSON chunks from MSFS BGL files.
This script mimics the JSON extraction logic from the Scone C# converter.
"""

import json
import os
import struct
from pathlib import Path


def validate_bgl_header(data):
    """Validate BGL file magic numbers."""
    magic1 = data[0:4]
    magic2 = data[0x10:0x14]

    expected1 = bytes([0x01, 0x02, 0x92, 0x19])
    expected2 = bytes([0x03, 0x18, 0x05, 0x08])

    return magic1 == expected1 and magic2 == expected2


def read_uint32(data, offset):
    """Read a uint32 from data at offset."""
    return struct.unpack("<I", data[offset : offset + 4])[0]


def read_uint16(data, offset):
    """Read a uint16 from data at offset."""
    return struct.unpack("<H", data[offset : offset + 2])[0]


def clean_json_string(json_bytes):
    """Replace non-printable characters with spaces."""
    cleaned = bytearray(json_bytes)
    for i in range(len(cleaned)):
        if cleaned[i] < 0x20 or cleaned[i] > 0x7E:
            cleaned[i] = 0x20  # Space character
    return bytes(cleaned)


def extract_json_from_glb(glb_bytes):
    """
    Extract and parse JSON from a GLB binary.
    GLB format: magic(4) + version(4) + length(4) + json_chunk_header(8) + json_data + bin_chunk_header(8) + bin_data
    """
    if len(glb_bytes) < 0x14:
        return None

    # Read JSON chunk length at offset 0x0C
    json_length = read_uint32(glb_bytes, 0x0C)

    # JSON data starts at offset 0x14
    json_start = 0x14
    json_end = json_start + json_length

    if json_end > len(glb_bytes):
        print(f"Warning: JSON length {json_length} exceeds GLB size {len(glb_bytes)}")
        return None

    # Extract and clean JSON bytes
    json_bytes = glb_bytes[json_start:json_end]
    json_bytes = clean_json_string(json_bytes)

    try:
        # Decode and parse JSON
        json_str = json_bytes.decode("utf-8", errors="ignore").strip()
        json_obj = json.loads(json_str)
        return json_obj
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        return None


def process_bgl_file(bgl_path, output_dir):
    """Process a single BGL file and extract all JSON chunks."""
    print(f"Processing: {bgl_path}")

    with open(bgl_path, "rb") as f:
        data = f.read()

    if len(data) < 0x38:
        print(f"File too small: {bgl_path}")
        return 0

    # Validate BGL header
    if not validate_bgl_header(data):
        print(f"Invalid BGL header: {bgl_path}")
        return 0

    # Read record count at offset 0x14
    record_count = read_uint32(data, 0x14)

    # Start reading records after 0x38-byte header
    offset = 0x38
    model_data_offsets = []

    # Find ModelData records (type 0x002B)
    for i in range(record_count):
        if offset + 0x14 > len(data):
            break

        record_type = read_uint32(data, offset)
        start_subsection = read_uint32(data, offset + 0x0C)
        read_uint32(data, offset + 0x10)

        if record_type == 0x002B:  # ModelData
            model_data_offsets.append(start_subsection)

        offset += 0x14

    json_count = 0
    bgl_name = Path(bgl_path).stem

    # Process each ModelData record
    for mdl_offset in model_data_offsets:
        if mdl_offset + 12 > len(data):
            continue

        subrec_offset = read_uint32(data, mdl_offset + 8)
        subrec_size = read_uint32(data, mdl_offset + 12)

        # Read model data subrecords
        objects_read = 0
        bytes_read = 0

        while bytes_read < subrec_size:
            obj_offset = subrec_offset + (24 * objects_read)

            if obj_offset + 24 > len(data):
                break

            # Read GUID (16 bytes)
            guid_bytes = data[obj_offset : obj_offset + 16]
            guid = guid_bytes.hex()

            start_model_data_offset = read_uint32(data, obj_offset + 16)
            model_data_size = read_uint32(data, obj_offset + 20)

            model_offset = subrec_offset + start_model_data_offset

            if model_offset + model_data_size > len(data):
                bytes_read += model_data_size + 24
                objects_read += 1
                continue

            mdl_bytes = data[model_offset : model_offset + model_data_size]

            # Check for RIFF signature
            if len(mdl_bytes) < 4 or mdl_bytes[0:4] != b"RIFF":
                bytes_read += model_data_size + 24
                objects_read += 1
                continue

            # Scan for GLBD chunks
            i = 8
            while i < len(mdl_bytes) - 4:
                chunk_id = mdl_bytes[i : i + 4]

                if chunk_id == b"GLBD":
                    if i + 8 > len(mdl_bytes):
                        break

                    chunk_size = read_uint32(mdl_bytes, i + 4)

                    # Scan GLBD payload for GLB blocks
                    j = i + 8
                    glb_index = 0

                    while j < min(i + 8 + chunk_size, len(mdl_bytes)):
                        if j + 8 > len(mdl_bytes):
                            break

                        sig = mdl_bytes[j : j + 4]

                        if sig == b"GLB\x00":
                            glb_size = read_uint32(mdl_bytes, j + 4)
                            glb_start = j + 8
                            glb_end = glb_start + glb_size

                            if glb_end > len(mdl_bytes):
                                print(f"Warning: GLB size {glb_size} exceeds bounds")
                                j += 4
                                continue

                            glb_bytes = mdl_bytes[glb_start:glb_end]

                            # Extract JSON from GLB
                            json_obj = extract_json_from_glb(glb_bytes)

                            if json_obj:
                                # Save JSON to file
                                json_filename = f"{bgl_name}_{guid}_{glb_index}.gltf"
                                json_path = os.path.join(output_dir, json_filename)

                                with open(json_path, "w", encoding="utf-8") as f:
                                    json.dump(json_obj, f, indent=2)

                                print(f"  Extracted: {json_filename}")
                                json_count += 1
                                glb_index += 1

                            j += 8 + glb_size
                        else:
                            j += 4

                    i += chunk_size

                i += 4

            bytes_read += model_data_size + 24
            objects_read += 1

    return json_count


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Extract JSON chunks from MSFS BGL files"
    )
    parser.add_argument(
        "input_path", help="Input BGL file or directory containing BGL files"
    )
    parser.add_argument("output_dir", help="Output directory for JSON files")
    parser.add_argument(
        "--recursive",
        "-r",
        action="store_true",
        help="Search for BGL files recursively",
    )

    args = parser.parse_args()

    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)

    # Find BGL files
    input_path = Path(args.input_path)

    if input_path.is_file():
        bgl_files = [input_path]
    elif input_path.is_dir():
        if args.recursive:
            bgl_files = list(input_path.rglob("*.bgl"))
        else:
            bgl_files = list(input_path.glob("*.bgl"))
    else:
        print(f"Error: {args.input_path} does not exist")
        return

    print(f"Found {len(bgl_files)} BGL file(s)")

    total_json = 0
    for bgl_file in bgl_files:
        count = process_bgl_file(str(bgl_file), args.output_dir)
        total_json += count

    print(f"\nTotal JSON files extracted: {total_json}")


if __name__ == "__main__":
    main()
