using System.Numerics;
using System.Text;
using System.Xml;
using Newtonsoft.Json.Linq;
using SharpGLTF.Geometry;
using SharpGLTF.Geometry.VertexTypes;
using SharpGLTF.Memory;
using SharpGLTF.Scenes;
using SharpGLTF.Schema2;

namespace Scone;

public class SceneryConverter : INotifyPropertyChanged
{
	private string _status = "Idle";
	public string Status
	{
		get => _status;
		private set
		{
			_status = value;
			OnPropertyChanged();
		}
	}
	public bool AbortAndCancel { get; set; } = false;
	public bool AbortAndSave { get; set; } = false;
	public event PropertyChangedEventHandler? PropertyChanged;
	private readonly MemoryImage Fallback = new("Assets/tex-fallback.png");
	public void ConvertScenery(string inputPath, string outputPath)
	{
		if (!Directory.Exists(inputPath))
		{
			Logger.Error($"Input path does not exist: {inputPath}");
			return;
		}

		string[] allBglFiles = Directory.GetFiles(inputPath, "*.bgl", SearchOption.AllDirectories);
		Dictionary<Guid, List<LibraryObject>> libraryObjects = [];
		int totalLibraryObjects = 0;
		// Gather placements first
		foreach (string file in allBglFiles)
		{
			using BinaryReader br = new(new FileStream(file, FileMode.Open, FileAccess.Read));
			Status = $"Looking for placements in {Path.GetFileName(file)}...";

			// Read and validate BGL header
			byte[] magicNumber1 = br.ReadBytes(4);
			_ = br.BaseStream.Seek(0x10, SeekOrigin.Begin);
			byte[] magicNumber2 = br.ReadBytes(4);
			if (!magicNumber1.SequenceEqual(new byte[] { 0x01, 0x02, 0x92, 0x19 }) ||
				!magicNumber2.SequenceEqual(new byte[] { 0x03, 0x18, 0x05, 0x08 }))
			{
				Logger.Warning($"Invalid BGL header in placement file: {Path.GetFileName(file)}");
				continue;
			}
			_ = br.BaseStream.Seek(0x14, SeekOrigin.Begin);
			uint recordCt = br.ReadUInt32();

			// Skip 0x38-byte header
			_ = br.BaseStream.Seek(0x38, SeekOrigin.Begin);

			List<int> mdlDataOffsets = [];
			List<int> sceneryObjectOffsets = [];
			int sceneryObjectSubrecordCount = 0;
			for (int i = 0; i < recordCt; i++)
			{
				long recordStartPos = br.BaseStream.Position;
				uint recType = br.ReadUInt32();
				_ = br.BaseStream.Seek(recordStartPos + 0x08, SeekOrigin.Begin);
				sceneryObjectSubrecordCount = (int)br.ReadUInt32();
				uint startSubsection = br.ReadUInt32();
				uint recSize = br.ReadUInt32();
				if (recType == 0x0025) // SceneryObject
				{
					for (int j = 0; j < sceneryObjectSubrecordCount; j++)
					{
						sceneryObjectOffsets.Add((int)startSubsection + (j * 16));
					}
				}
			}

			// Parse SceneryObject subrecords
			List<(int offset, int size)> sceneryObjectSubrecords = [];
			foreach (int sceneryOffset in sceneryObjectOffsets)
			{
				_ = br.BaseStream.Seek(sceneryOffset + 8, SeekOrigin.Begin);
				int subrecOffset = (int)br.ReadUInt32();
				int size = (int)br.ReadUInt32();
				sceneryObjectSubrecords.Add((subrecOffset, size));
			}

			int bytesRead = 0;
			foreach ((int subOffset, int subSize) in sceneryObjectSubrecords)
			{
				bytesRead = 0;
				while (bytesRead < subSize)
				{
					_ = br.BaseStream.Seek(subOffset + bytesRead, SeekOrigin.Begin);
					ushort id = br.ReadUInt16();
					if (id != 0x0B) // LibraryObject
					{
						uint skip = br.ReadUInt16();
						Logger.Warning($"Unexpected subrecord type at offset 0x{subOffset + bytesRead:X}: 0x{id:X4}, skipping {skip} bytes");
						_ = br.BaseStream.Seek(subOffset + skip, SeekOrigin.Begin);
						bytesRead += (int)skip;
						continue;
					}
					ushort size = br.ReadUInt16();
					uint longitude = br.ReadUInt32(), latitude = br.ReadUInt32();
					double altitude = br.ReadInt32() / 1000.0;
					ushort flagsValue = br.ReadUInt16();
					List<Flags> flagsList = [];
					for (int j = 0; j < 7; j++)
					{
						if ((byte)((flagsValue >> j) & 1) != 0)
						{
							flagsList.Add((Flags)j);
						}
					}
					Flags[] flags = [.. flagsList];
					ushort pitch = br.ReadUInt16();
					ushort bank = br.ReadUInt16();
					ushort heading = br.ReadUInt16();
					short imageComplexity = br.ReadInt16();
					_ = br.BaseStream.Seek(2, SeekOrigin.Current); // There is an unknown 2-byte field here
					_ = br.BaseStream.Seek(16, SeekOrigin.Current); // Skip GUID empty field
					Guid guid = new(br.ReadBytes(16));
					double scale = br.ReadSingle(); // Read as float from file, store as double for precision
					LibraryObject libObj = new()
					{
						id = id,
						size = size,
						longitude = (longitude * (360.0 / 805306368.0)) - 180.0,
						latitude = 90.0 - (latitude * (180.0 / 536870912.0)),
						altitude = flags.Contains(Flags.IsAboveAGL) ? altitude + Terrain.GetElevation((float)(90.0 - (latitude * (180.0 / 536870912.0))), (float)((longitude * (360.0 / 805306368.0)) - 180.0)) : altitude,
						flags = flags,
						pitch = Math.Round(pitch * (360.0 / 65536.0), 3),
						bank = Math.Round(bank * (360.0 / 65536.0), 3),
						heading = Math.Round(heading * (360.0 / 65536.0), 3),
						imageComplexity = imageComplexity,
						guid = guid,
						scale = Math.Round(scale, 3)
					};
					if (!libraryObjects.TryGetValue(guid, out _))
					{
						libraryObjects[guid] = [];
					}
					libraryObjects[guid].Add(libObj);
					totalLibraryObjects++;
					Status = $"Looking for placements in {Path.GetFileName(file)}... found {totalLibraryObjects}";
					Logger.Debug($"{guid}\t{libObj.size}\t{libObj.longitude:F6}\t{libObj.latitude:F6}\t{libObj.altitude}\t[{string.Join(",", libObj.flags)}]\t{libObj.pitch:F2}\t{libObj.bank:F2}\t{libObj.heading:F2}\t{libObj.imageComplexity}\t{libObj.scale}");
					bytesRead += size;
				}
			}
		}

		// Models need to be written combined on a tile-by-tile basis to minimize RAM consumption
		// We have all the placements and their GUIDs, so run through the model BGLs and create a Dictionary
		// The key will be the tile index, and the value will be a list of access points of models (file, binary address, size)
		// After the dictionary has been completed, we will go back through and write out each tile's models to the respective folder

		// Track which GUIDs have models
		HashSet<Guid> guidsWithModels = [];
		Dictionary<int, List<ModelReference>> modelReferencesByTile = [];

		// Look for models after placements have been gathered
		foreach (string file in allBglFiles)
		{
			using BinaryReader br = new(new FileStream(file, FileMode.Open, FileAccess.Read));
			Status = $"Looking for models in {Path.GetFileName(file)}...";

			// Read and validate BGL header
			byte[] magicNumber1 = br.ReadBytes(4);
			_ = br.BaseStream.Seek(0x10, SeekOrigin.Begin);
			byte[] magicNumber2 = br.ReadBytes(4);
			if (!magicNumber1.SequenceEqual(new byte[] { 0x01, 0x02, 0x92, 0x19 }) ||
				!magicNumber2.SequenceEqual(new byte[] { 0x03, 0x18, 0x05, 0x08 }))
			{
				Logger.Warning($"Invalid BGL header in model data file: {Path.GetFileName(file)}");
				continue;
			}
			_ = br.BaseStream.Seek(0x14, SeekOrigin.Begin);
			uint recordCt = br.ReadUInt32();

			// Skip 0x38-byte header
			_ = br.BaseStream.Seek(0x38, SeekOrigin.Begin);

			List<int> mdlDataOffsets = [];
			for (int i = 0; i < recordCt; i++)
			{
				long recordStartPos = br.BaseStream.Position;
				uint recType = br.ReadUInt32();
				_ = br.BaseStream.Seek(recordStartPos + 0x0C, SeekOrigin.Begin);
				uint startSubsection = br.ReadUInt32();
				_ = br.BaseStream.Seek(recordStartPos + 0x10, SeekOrigin.Begin);
				uint recSize = br.ReadUInt32();
				if (recType == 0x002B) // ModelData
				{
					mdlDataOffsets.Add((int)startSubsection);
				}
			}

			int bytesRead = 0;

			Dictionary<int, List<string>> finalPlacementsByTile = [];
			// Parse ModelData subrecords
			List<(int offset, int size)> modelDataSubrecords = [];
			foreach (int modelDataOffset in mdlDataOffsets)
			{
				_ = br.BaseStream.Seek(modelDataOffset + 8, SeekOrigin.Begin);
				int subrecOffset = br.ReadInt32();
				int size = br.ReadInt32();
				modelDataSubrecords.Add((subrecOffset, size));
			}
			foreach ((int subOffset, int subSize) in modelDataSubrecords)
			{
				// Reset per-subrecord counters so all subrecords are processed
				int objectsRead = 0;
				bytesRead = 0;

				while (bytesRead < subSize)
				{
					_ = br.BaseStream.Seek(subOffset + (24 * objectsRead), SeekOrigin.Begin);
					byte[] guidBytes = br.ReadBytes(16);
					Guid guid = new(guidBytes);
					uint startModelDataOffset = br.ReadUInt32();
					uint modelDataSize = br.ReadUInt32();
					if (!libraryObjects.ContainsKey(guid))
					{
						Logger.Info($"Model GUID {guid}, size {modelDataSize} at offset 0x{startModelDataOffset:X} not found in placements; skipping.");
						bytesRead += (int)modelDataSize + 24;
						objectsRead++;
						continue;
					}

					// Mark this GUID as having a model
					guidsWithModels.Add(guid);

					List<int> tileIndices = [.. libraryObjects[guid].Select(lo => Terrain.GetTileIndex(lo.latitude, lo.longitude)).Distinct()];
					foreach (int tileIndex in tileIndices)
					{
						if (!modelReferencesByTile.TryGetValue(tileIndex, out List<ModelReference>? value))
						{
							value = [];
							modelReferencesByTile[tileIndex] = value;
						}

						value.Add(new ModelReference
						{
							guid = guid,
							file = file,
							offset = (int)startModelDataOffset + 0x80, // Why the 0x80-byte offset? Who knows?
							size = (int)modelDataSize
						});
					}
					_ = br.BaseStream.Seek(subOffset + startModelDataOffset + (int)modelDataSize, SeekOrigin.Begin);
					bytesRead += (int)modelDataSize + 24;
					objectsRead++;
				}
			}
		}
		int totalModelCount = modelReferencesByTile.Values.Sum(l => l.Count);
		int modelsProcessed = 0;
		Logger.Info($"Found {totalModelCount} models");

		foreach (var kvp in modelReferencesByTile)
		{
			int tileIndex = kvp.Key;
			List<ModelReference> modelRefs = [.. kvp.Value.OrderByDescending(mr => mr.size)];
			Logger.Info($"Tile {tileIndex} has {modelRefs.Count} model references");
			SceneBuilder scene = new();
			List<LibraryObject> libraryObjectsForTile = [.. libraryObjects.Values.SelectMany(loList => loList).Where(lo => Terrain.GetTileIndex(lo.latitude, lo.longitude) == tileIndex)];
			double latOrigin = libraryObjectsForTile.Count > 0 ? libraryObjectsForTile.Sum(lo => lo.latitude) / libraryObjectsForTile.Count : 0.0;
			double lonOrigin = libraryObjectsForTile.Count > 0 ? libraryObjectsForTile.Sum(lo => lo.longitude) / libraryObjectsForTile.Count : 0.0;
			double altOrigin = libraryObjectsForTile.Count > 0 ? libraryObjectsForTile.Sum(lo => lo.altitude) / libraryObjectsForTile.Count : 0.0;
			foreach (ModelReference modelRef in modelRefs)
			{
				if (AbortAndCancel)
				{
					Logger.Info("Conversion aborted by user.");
					return;
				}
				modelsProcessed++;
				List<LibraryObject> libraryObjectsForModel = libraryObjects.TryGetValue(modelRef.guid, out List<LibraryObject>? value) ? value : [];
				BinaryReader brModel = new(new FileStream(modelRef.file, FileMode.Open, FileAccess.Read));
				_ = brModel.BaseStream.Seek(modelRef.offset, SeekOrigin.Begin);
				byte[] mdlBytes = brModel.ReadBytes(modelRef.size);
				Logger.Debug($"Model reference: {modelRef.file} at offset 0x{modelRef.offset:X} size {modelRef.size} guid {modelRef.guid}");
				string name = "";
				List<LodData> lods = [];
				List<LightObject> lightObjects = [];
				string chunkID = Encoding.ASCII.GetString(mdlBytes, 0, Math.Min(4, mdlBytes.Length));
				if (chunkID != "RIFF")
				{
					continue;
				}
				List<ModelObject> modelObjects = [];
				// Enter this model and get LOD info, GLB files, and mesh data
				for (int i = 8; i < mdlBytes.Length; i += 4)
				{
					string chunk = Encoding.ASCII.GetString(mdlBytes, i, Math.Min(4, mdlBytes.Length - i));
					if (chunk == "GXML")
					{
						int size = BitConverter.ToInt32(mdlBytes, i + 4);
						string gxmlContent = Encoding.UTF8.GetString(mdlBytes, i + 8, size);
						try
						{
							XmlDocument xmlDoc = new();
							xmlDoc.LoadXml(gxmlContent);
							name = xmlDoc.GetElementsByTagName("ModelInfo")[0]?.Attributes?["name"]?.Value.Replace(".gltf", "").Replace(" ", "_") ?? "Unnamed_Model";
							XmlNodeList lodNodes = xmlDoc.GetElementsByTagName("LOD");
							foreach (XmlNode lodNode in lodNodes)
							{
								string lodObjName = lodNode?.Attributes?["ModelFile"]?.Value.Replace(".gltf", "") ?? "Unnamed";
								int minSize = 0;
								try
								{
									minSize = int.Parse(lodNode?.Attributes?["minSize"]?.Value ?? "0");
								}
								catch (FormatException)
								{
									continue;
								}
								if (lodObjName != "Unnamed")
								{
									lods.Add(new LodData
									{
										name = lodObjName,
										minSize = minSize
									});
								}
							}
						}
						catch (XmlException)
						{
							Logger.Warning($"Failed to parse GXML for model {modelRef.guid:X}");
						}
						i += size;
					}
					else if (chunk == "GLBD")
					{
						Logger.Info($"Processing GLBD chunk for model {name} ({modelRef.guid:X}) in {modelRef.file}");
						Status = $"Processing model {name} ({modelsProcessed} of {totalModelCount})...";
						int size = BitConverter.ToInt32(mdlBytes, i + 4);
						int glbIndex = 0; // for unique filenames per GLB in this chunk

						// Scan GLBD payload and skip past each GLB block once processed
						for (int j = i + 8; j < i + 8 + size;)
						{
							// Ensure there are at least 8 bytes for type + size
							if (j + 8 > mdlBytes.Length) break;

							string sig = Encoding.ASCII.GetString(mdlBytes, j, Math.Min(4, mdlBytes.Length - j));
							if (sig == "GLB\0")
							{
								int glbSize = BitConverter.ToInt32(mdlBytes, j + 4);
								// byte[] glbBytesPre = br.ReadBytes(glbSize);
								byte[] glbBytes = mdlBytes[(j + 8)..(j + 8 + glbSize)];

								// Fill the end of the JSON chunk with spaces, and replace non-printable characters with spaces.
								uint JSONLength = BitConverter.ToUInt32(glbBytes, 0x0C);
								for (int k = 0x14; k < 0x14 + JSONLength; k++)
								{
									if (glbBytes[k] < 0x20 || glbBytes[k] > 0x7E)
									{
										glbBytes[k] = 0x20;
									}
								}

								JObject json = JObject.Parse(Encoding.UTF8.GetString(glbBytes, 0x14, (int)JSONLength).Trim());
								JArray meshes = (JArray)json["meshes"]! ?? [];
								JArray accessors = (JArray)json["accessors"]! ?? [];
								JArray bufferViews = (JArray)json["bufferViews"]! ?? [];
								JArray images = (JArray)json["images"]! ?? [];
								JArray materials = (JArray)json["materials"]! ?? [];
								JArray textures = (JArray)json["textures"]! ?? [];

								if (bufferViews.Count == 0 || accessors.Count == 0 || meshes.Count == 0)
								{
									Logger.Info($"GLB in model {name} ({modelRef.guid:X}) has no mesh data; skipping.");
									// Advance j past this GLB record (type[4] + size[4] + payload[glbSize])
									j += 8 + glbSize;
									continue;
								}

								uint binLength = BitConverter.ToUInt32(glbBytes, 0x14 + (int)JSONLength);
								byte[] glbBinBytes = glbBytes[(0x14 + (int)JSONLength + 8)..(0x14 + (int)JSONLength + 8 + (int)binLength)];

								SceneBuilder sceneLocal = CreateModelFromGlb(glbBytes, inputPath, modelRef.file);

								// Write GLB with unique filename (include index to avoid overwrites)
								string safeName = name;
								string outName = glbIndex < lods.Count ? lods[glbIndex].name : $"{safeName}_glb{glbIndex}";
								modelObjects.Add(new ModelObject
								{
									name = outName.Replace(" ", "_"),
									minSize = glbIndex < lods.Count ? lods[glbIndex].minSize : 0,
									model = sceneLocal
								});
								foreach (LibraryObject libObj in libraryObjectsForModel)
								{
									double deg2rad = Math.PI / 180.0;
									double lonOffsetMeters = -(libObj.longitude - lonOrigin) * 111320.0 * Math.Cos(latOrigin * deg2rad);
									double latOffsetMeters = (libObj.latitude - latOrigin) * 110540.0;
									double altOffsetMeters = libObj.altitude - altOrigin;

									// glTF: X = east (lon), Y = up (alt), Z = south (lat)
									Vector3 translation = new((float)lonOffsetMeters, (float)altOffsetMeters, (float)latOffsetMeters);
									float yaw = (float)(-libObj.heading * deg2rad); // negative for right-handed glTF
									float pitch = (float)(libObj.pitch * deg2rad);
									float roll = (float)(libObj.bank * deg2rad);
									Quaternion rotation = Quaternion.CreateFromYawPitchRoll(yaw, pitch, roll);
									Vector3 scale = new((float)libObj.scale, (float)libObj.scale, (float)libObj.scale);
									Matrix4x4 transform = Matrix4x4.CreateScale(scale) * Matrix4x4.CreateFromQuaternion(rotation) * Matrix4x4.CreateTranslation(translation);
									_ = scene.AddScene(sceneLocal, transform);
								}
								glbIndex++;

								// Advance j past this GLB record (type[4] + size[4] + payload[glbSize])
								j += 8 + glbSize;
								if (glbIndex >= 1)
								{
									Logger.Info($"More than one LOD present for {name}; skipping remaining GLB in chunk.");
									// The highest LOD is the first GLB; break after processing it
									break;
								}
							}
							else
							{
								// Not a GLB block; advance reasonably (try to skip unknown 8-byte header or 4-byte step)
								// Prefer 4-byte alignment advance to find next signature
								j += 4;
							}
						}

						// Advance i past the GLBD chunk payload
						i += size;
					}
				}
				if (modelObjects.Count == 0)
				{
					continue;
				}
				if (AbortAndSave)
				{
					Logger.Info("Conversion aborted by user; saving progress.");
					break;
				}
			}
			(double lat, double lon) = Terrain.GetLatLon(tileIndex);
			string lonHemi = lon >= 0 ? "e" : "w";
			string latHemi = lat >= 0 ? "n" : "s";
			string path = $"{outputPath}/Objects/{lonHemi}{Math.Abs(Math.Floor(lon / 10)) * 10:000}{latHemi}{Math.Abs(Math.Floor(lat / 10)) * 10:00}/{lonHemi}{Math.Abs(Math.Floor(lon)):000}{latHemi}{Math.Abs(Math.Floor(lat)):00}";
			if (!Directory.Exists(path))
			{
				_ = Directory.CreateDirectory(path);
			}

			string outGlbPath = Path.Combine(path, $"{tileIndex}.gltf");
			Status = "Saving model to disk...";
			scene.ToGltf2().SaveGLTF(outGlbPath, new WriteSettings
			{
				ImageWriting = ResourceWriteMode.SatelliteFile,
				ImageWriteCallback = (context, assetName, image) =>
				{
					// This name doesn't matter; we will fix up the URIs in the postprocessor
					return "";
				},
				JsonPostprocessor = (json) =>
				{
					JObject gltfText = JObject.Parse(json);
					Dictionary<string, int> imageUriToIndex = [];
					JArray images = [];
					// Assign proper sources for textures using extensions
					foreach (JObject mat in gltfText["materials"]?.Cast<JObject>() ?? [])
					{
						if (mat["pbrMetallicRoughness"]?["baseColorTexture"] != null)
						{
							string baseColorTex = mat["extras"]!["baseColorTexture"]!.Value<string>() ?? "";
							int texIndex = mat["pbrMetallicRoughness"]!["baseColorTexture"]!["index"]!.Value<int>();
							JObject currentTexture = new()
							{
								["extensions"] = new JObject
								{
									["MSFT_texture_dds"] = new JObject
									{
										["source"] = images.Count
									}
								},
								["source"] = images.Count
							};
							if (imageUriToIndex.TryGetValue(baseColorTex, out int existingIndex))
							{
								currentTexture["source"] = existingIndex;
								currentTexture["extensions"]!["MSFT_texture_dds"]!["source"] = existingIndex;
							}
							else
							{
								imageUriToIndex[baseColorTex] = images.Count;
								images.Add(new JObject
								{
									["uri"] = Path.GetFileName(baseColorTex)
								});
							}
							gltfText["textures"]?[texIndex] = currentTexture;
							File.Copy(baseColorTex, Path.Combine(path, Path.GetFileName(baseColorTex)), true);
						}
						if (mat["pbrMetallicRoughness"]?["metallicRoughnessTexture"] != null)
						{
							string metallicRoughnessTex = mat["extras"]!["metallicRoughnessTexture"]!.Value<string>() ?? "";
							int texIndex = mat["pbrMetallicRoughness"]!["metallicRoughnessTexture"]!["index"]!.Value<int>();
							JObject currentTexture = new()
							{
								["extensions"] = new JObject
								{
									["MSFT_texture_dds"] = new JObject
									{
										["source"] = images.Count
									}
								},
								["source"] = images.Count
							};
							if (imageUriToIndex.TryGetValue(metallicRoughnessTex, out int existingIndex))
							{
								currentTexture["source"] = existingIndex;
								currentTexture["extensions"]!["MSFT_texture_dds"]!["source"] = existingIndex;
							}
							else
							{
								imageUriToIndex[metallicRoughnessTex] = images.Count;
								images.Add(new JObject
								{
									["uri"] = Path.GetFileName(metallicRoughnessTex)
								});
							}
							gltfText["textures"]?[texIndex] = currentTexture;
							File.Copy(metallicRoughnessTex, Path.Combine(path, Path.GetFileName(metallicRoughnessTex)), true);
						}
						if (mat["normalTexture"] != null)
						{
							string normaTex = mat["extras"]!["normalTexture"]!.Value<string>() ?? "";
							int texIndex = mat["normalTexture"]!["index"]!.Value<int>();
							JObject currentTexture = new()
							{
								["extensions"] = new JObject
								{
									["MSFT_texture_dds"] = new JObject
									{
										["source"] = images.Count
									}
								},
								["source"] = images.Count
							};
							if (imageUriToIndex.TryGetValue(normaTex, out int existingIndex))
							{
								currentTexture["source"] = existingIndex;
								currentTexture["extensions"]!["MSFT_texture_dds"]!["source"] = existingIndex;
							}
							else
							{
								imageUriToIndex[normaTex] = images.Count;
								images.Add(new JObject
								{
									["uri"] = Path.GetFileName(normaTex)
								});
							}
							gltfText["textures"]?[texIndex] = currentTexture;
							File.Copy(normaTex, Path.Combine(path, Path.GetFileName(normaTex)), true);
						}
						if (mat["occlusionTexture"] != null)
						{
							string occlusionTex = mat["extras"]!["occlusionTexture"]!.Value<string>() ?? "";
							int texIndex = mat["occlusionTexture"]!["index"]!.Value<int>();
							JObject currentTexture = new()
							{
								["extensions"] = new JObject
								{
									["MSFT_texture_dds"] = new JObject
									{
										["source"] = images.Count
									}
								},
								["source"] = images.Count
							};
							if (imageUriToIndex.TryGetValue(occlusionTex, out int existingIndex))
							{
								currentTexture["source"] = existingIndex;
								currentTexture["extensions"]!["MSFT_texture_dds"]!["source"] = existingIndex;
							}
							else
							{
								imageUriToIndex[occlusionTex] = images.Count;
								images.Add(new JObject
								{
									["uri"] = Path.GetFileName(occlusionTex)
								});
							}
							gltfText["textures"]?[texIndex] = currentTexture;
							File.Copy(occlusionTex, Path.Combine(path, Path.GetFileName(occlusionTex)), true);
						}
						if (mat["emissiveTexture"] != null)
						{
							string emissiveTex = mat["extras"]!["emissiveTexture"]!.Value<string>() ?? "";
							int texIndex = mat["emissiveTexture"]!["index"]!.Value<int>();
							JObject currentTexture = new()
							{
								["extensions"] = new JObject
								{
									["MSFT_texture_dds"] = new JObject
									{
										["source"] = images.Count
									}
								},
								["source"] = images.Count
							};
							if (imageUriToIndex.TryGetValue(emissiveTex, out int existingIndex))
							{
								currentTexture["source"] = existingIndex;
								currentTexture["extensions"]!["MSFT_texture_dds"]!["source"] = existingIndex;
							}
							else
							{
								imageUriToIndex[emissiveTex] = images.Count;
								images.Add(new JObject
								{
									["uri"] = Path.GetFileName(emissiveTex)
								});
							}
							gltfText["textures"]?[texIndex] = currentTexture;
							File.Copy(emissiveTex, Path.Combine(path, Path.GetFileName(emissiveTex)), true);
						}
					}
					gltfText["images"] = images;
					return gltfText.ToString();
				}
			});

			bool hasXml = false;
			string activeName = $"{tileIndex}.{(hasXml ? "xml" : "gltf")}";
			string placementStr = $"OBJECT_STATIC {activeName} {lonOrigin} {latOrigin} {altOrigin} {270} {0} {90}";
			File.WriteAllText(Path.Combine(path, $"{tileIndex}.stg"), placementStr);
			if (AbortAndSave)
			{
				Logger.Info("Conversion aborted by user; saving progress.");
				break;
			}
		}

		// Report unused LibraryObjects (placements without models)
		List<Guid> unusedGuids = libraryObjects.Keys.Where(guid => !guidsWithModels.Contains(guid)).ToList();
		if (unusedGuids.Count > 0)
		{
			Logger.Info($"\n=== Found {unusedGuids.Count} LibraryObject GUIDs with placements but no models ===");
			int totalUnusedPlacements = 0;
			foreach (var guid in unusedGuids)
			{
				int placementCount = libraryObjects[guid].Count;
				totalUnusedPlacements += placementCount;
				Logger.Debug($"GUID: {guid} - {placementCount} placement(s)");
				// Show first placement as example
				if (libraryObjects[guid].Count > 0)
				{
					var example = libraryObjects[guid][0];
					Logger.Debug($"  Example: Lat {example.latitude:F6}, Lon {example.longitude:F6}, Alt {example.altitude:F2}m");
				}
			}
			Logger.Info($"Total unused placements: {totalUnusedPlacements}");
		}
		else
		{
			Logger.Info("\nAll LibraryObjects have corresponding models.");
		}

		Logger.Info("Conversion complete.");
		Logger.FlushToFile();
	}

	private static SceneBuilder CreateModelFromGltf(byte[] glbBinBytes, JObject json, string inputPath, string file)
	{
		SceneBuilder scene = new();
		JArray meshes = (JArray)json["meshes"]!;
		JArray accessors = (JArray)json["accessors"]!;
		JArray bufferViews = (JArray)json["bufferViews"]!;
		JArray images = (JArray)json["images"]!;
		JArray materials = (JArray)json["materials"]!;
		JArray textures = (JArray)json["textures"]!;
		Dictionary<int, List<int>> meshIndexToSceneNodeIndex = [];
		for (int k = 0; k < json["nodes"]!.Count(); k++)
		{
			JObject node = (JObject)json["nodes"]![k]!;
			if (node["mesh"] != null)
			{
				int meshIndex = node["mesh"]!.Value<int>();
				if (!meshIndexToSceneNodeIndex.TryGetValue(meshIndex, out List<int>? valueMesh))
				{
					valueMesh = [];
					meshIndexToSceneNodeIndex[meshIndex] = valueMesh;
				}
				meshIndexToSceneNodeIndex[meshIndex].Add(k);
			}
		}

		// Build parent map for nodes
		JArray nodesArray = (JArray)json["nodes"]!;
		int nodeCount = nodesArray.Count;
		int[] parentMap = new int[nodeCount];
		for (int n = 0; n < nodeCount; n++) parentMap[n] = -1;
		for (int n = 0; n < nodeCount; n++)
		{
			JObject node = (JObject)nodesArray[n]!;
			if (node["children"] != null)
			{
				foreach (var child in (JArray)node["children"]!)
				{
					int childIdx = child.Value<int>();
					parentMap[childIdx] = n;
				}
			}
		}

		// Helper: Compute world transform for a node
		Matrix4x4 GetWorldTransform(int nodeIdx)
		{
			Matrix4x4 result = Matrix4x4.Identity;
			int? current = nodeIdx;
			while (current != null && current >= 0)
			{
				JObject node = (JObject)nodesArray[current.Value]!;
				// Build local transform
				Vector3 t = node["translation"] != null ? new Vector3(
					node["translation"]![0]!.Value<float>(),
					node["translation"]![1]!.Value<float>(),
					node["translation"]![2]!.Value<float>()) : Vector3.Zero;
				Quaternion r = node["rotation"] != null ? new Quaternion(
					node["rotation"]![0]!.Value<float>(),
					node["rotation"]![1]!.Value<float>(),
					node["rotation"]![2]!.Value<float>(),
					node["rotation"]![3]!.Value<float>()) : Quaternion.Identity;
				Vector3 s = node["scale"] != null ? new Vector3(
					node["scale"]![0]!.Value<float>(),
					node["scale"]![1]!.Value<float>(),
					node["scale"]![2]!.Value<float>()) : Vector3.One;
				float avgScale = (s.X + s.Y + s.Z) / 3.0f;
				if (!float.IsFinite(avgScale) || avgScale <= 0f) avgScale = 1f;
				s = new Vector3(avgScale, avgScale, avgScale);
				Matrix4x4 local = Matrix4x4.CreateScale(s) * Matrix4x4.CreateFromQuaternion(Quaternion.Normalize(r)) * Matrix4x4.CreateTranslation(t);
				result = local * result;
				current = parentMap[current.Value] >= 0 ? parentMap[current.Value] : null;
			}
			return result;
		}

		foreach (JObject mesh in meshes.Cast<JObject>())
		{
			MeshBuilder<VertexPositionNormalTangent, VertexTexture2, VertexEmpty>? meshBuilder = GlbBuilder.BuildMesh(inputPath, file, mesh, accessors, bufferViews, materials, textures, images, glbBinBytes);
			if (meshBuilder == null) continue;
			int meshIdx = meshes.IndexOf(mesh);
			if (!meshIndexToSceneNodeIndex.TryGetValue(meshIdx, out List<int>? nodeIndices)) continue;
			foreach (int nodeIndex in nodeIndices)
			{
				Matrix4x4 transform = GetWorldTransform(nodeIndex);
				// Validate matrix before passing to SharpGLTF
				if (!(float.IsFinite(transform.M11) && float.IsFinite(transform.M12) && float.IsFinite(transform.M13) && float.IsFinite(transform.M14)
					&& float.IsFinite(transform.M21) && float.IsFinite(transform.M22) && float.IsFinite(transform.M23) && float.IsFinite(transform.M24)
					&& float.IsFinite(transform.M31) && float.IsFinite(transform.M32) && float.IsFinite(transform.M33) && float.IsFinite(transform.M34)
					&& float.IsFinite(transform.M41) && float.IsFinite(transform.M42) && float.IsFinite(transform.M43) && float.IsFinite(transform.M44)))
				{
					// Skip this mesh if transform is invalid to prevent runtime exception
					continue;
				}
				_ = scene.AddRigidMesh(meshBuilder, transform);
			}
		}
		return scene;
	}

	private static SceneBuilder CreateModelFromGlb(byte[] glbBytes, string inputPath, string file)
	{
		// Fill the end of the JSON chunk with spaces, and replace non-printable characters with spaces.
		uint JSONLength = BitConverter.ToUInt32(glbBytes, 0x0C);
		for (int k = 0x14; k < 0x14 + JSONLength; k++)
		{
			if (glbBytes[k] < 0x20 || glbBytes[k] > 0x7E)
			{
				glbBytes[k] = 0x20;
			}
		}

		uint binLength = BitConverter.ToUInt32(glbBytes, 0x14 + (int)JSONLength);
		byte[] glbBinBytes = glbBytes[(0x14 + (int)JSONLength + 8)..(0x14 + (int)JSONLength + 8 + (int)binLength)];

		JObject json = JObject.Parse(Encoding.UTF8.GetString(glbBytes, 0x14, (int)JSONLength).Trim());
		return CreateModelFromGltf(glbBinBytes, json, inputPath, file);
	}

	private static XmlNode CreateLightElement(XmlDocument doc, LightObject light)
	{
		XmlElement lightElem = doc.CreateElement("light");
		lightElem.AppendChild(doc.CreateElement("name"))!.InnerText = light.name ?? "Unnamed_Light";
		lightElem.AppendChild(doc.CreateElement("type"))!.InnerText = light.cutoffAngle <= 90 ? "spot" : "point";
		XmlElement? positionElem = lightElem.AppendChild(doc.CreateElement("position")) as XmlElement;
		positionElem!.AppendChild(doc.CreateElement("x-m"))!.InnerText = light.position.X.ToString();
		positionElem.AppendChild(doc.CreateElement("y-m"))!.InnerText = (-light.position.Z).ToString();
		positionElem.AppendChild(doc.CreateElement("z-m"))!.InnerText = light.position.Y.ToString();

		if (light.cutoffAngle <= 90)
		{
			lightElem.AppendChild(doc.CreateElement("pitch-deg"))!.InnerText = light.pitchDeg.ToString();
			lightElem.AppendChild(doc.CreateElement("roll-deg"))!.InnerText = light.rollDeg.ToString();
			lightElem.AppendChild(doc.CreateElement("heading-deg"))!.InnerText = light.headingDeg.ToString();
		}

		XmlElement? colorElem = lightElem.AppendChild(doc.CreateElement("color")) as XmlElement;
		colorElem!.AppendChild(doc.CreateElement("r"))!.InnerText = light.color.X.ToString();
		colorElem.AppendChild(doc.CreateElement("g"))!.InnerText = light.color.Y.ToString();
		colorElem.AppendChild(doc.CreateElement("b"))!.InnerText = light.color.Z.ToString();
		colorElem.AppendChild(doc.CreateElement("a"))!.InnerText = light.color.W.ToString();
		lightElem.AppendChild(doc.CreateElement("intensity"))!.InnerText = light.intensity.ToString();

		if (light.cutoffAngle <= 90)
		{
			lightElem.AppendChild(doc.CreateElement("spot-exponent"))!.InnerText = light.spot_exponent.ToString();
			lightElem.AppendChild(doc.CreateElement("spot-cutoff"))!.InnerText = light.cutoffAngle.ToString();
			lightElem.AppendChild(doc.CreateElement("range-m"))!.InnerText = light.range_m.ToString();
		}

		if (light.dayNightCycle || light.flashDuration > 0 || light.flashFrequency > 0 || light.rotationSpeed != 0)
		{
			// Combine all of these things to the dim factor expression
			// XmlElement dimFactor = lightElem.AppendChild(doc.CreateElement("dim-factor")) as XmlElement;
		}
		return lightElem;
	}

	private static XmlNode CreateScaleElement(XmlDocument doc, float scale, ModelData model)
	{
		XmlElement scaleElem = doc.CreateElement("animation");
		scaleElem.AppendChild(doc.CreateElement("type"))!.InnerText = "scale";
		foreach (ModelObject modelObj in model.modelObjects)
		{
			scaleElem.AppendChild(doc.CreateElement("object-name"))!.InnerText = modelObj.name;
		}
		scaleElem.AppendChild(doc.CreateElement("x"))!.InnerText = scale.ToString();
		scaleElem.AppendChild(doc.CreateElement("y"))!.InnerText = scale.ToString();
		scaleElem.AppendChild(doc.CreateElement("z"))!.InnerText = scale.ToString();
		return scaleElem;
	}

	private static XmlNode CreateLodElement(XmlDocument doc, float radius, int minSize, int? maxSize)
	{
		XmlElement lodElem = doc.CreateElement("animation");
		lodElem.AppendChild(doc.CreateElement("type"))!.InnerText = "range";

		// Build <min-property> structure per requested XML
		XmlElement minProp = doc.CreateElement("min-property");
		XmlElement exprMin = doc.CreateElement("expression");
		XmlElement divMin = doc.CreateElement("div");

		// First <prod>
		XmlElement prodMin1 = doc.CreateElement("prod");
		XmlElement valueRadiusMin = doc.CreateElement("value");
		valueRadiusMin.InnerText = radius.ToString("F2");
		XmlElement propertyScreenHeightMin = doc.CreateElement("property");
		propertyScreenHeightMin.InnerText = "720";
		_ = prodMin1.AppendChild(valueRadiusMin);
		_ = prodMin1.AppendChild(propertyScreenHeightMin);

		// Second <prod>
		XmlElement prodMin2 = doc.CreateElement("prod");
		XmlElement valueMinSize = doc.CreateElement("value");
		valueMinSize.InnerText = minSize.ToString();
		XmlElement tanMin = doc.CreateElement("tan");
		XmlElement tanMinProd = doc.CreateElement("prod");
		XmlElement valueHalfMin = doc.CreateElement("value");
		valueHalfMin.InnerText = "0.5";
		XmlElement deg2radMin = doc.CreateElement("deg2rad");
		XmlElement fovPropertyMin = doc.CreateElement("property");
		fovPropertyMin.InnerText = "/sim/current-view/field-of-view";
		_ = deg2radMin.AppendChild(fovPropertyMin);
		_ = tanMinProd.AppendChild(valueHalfMin);
		_ = tanMinProd.AppendChild(deg2radMin);
		_ = tanMin.AppendChild(tanMinProd);
		_ = prodMin2.AppendChild(valueMinSize);
		_ = prodMin2.AppendChild(tanMin);

		// Append to min property div
		_ = divMin.AppendChild(prodMin1);
		_ = divMin.AppendChild(prodMin2);
		_ = exprMin.AppendChild(divMin);
		_ = minProp.AppendChild(exprMin);

		_ = lodElem.AppendChild(minProp);

		if (maxSize != null)
		{
			// Build <max-property> structure per requested XML
			XmlElement maxProp = doc.CreateElement("max-property");
			XmlElement exprMax = doc.CreateElement("expression");
			XmlElement divMax = doc.CreateElement("div");

			// First <prod> for max
			XmlElement prodMax1 = doc.CreateElement("prod");
			XmlElement valueRadiusMax = doc.CreateElement("value");
			valueRadiusMax.InnerText = radius.ToString("F2");
			XmlElement propertyScreenHeightMax = doc.CreateElement("property");
			propertyScreenHeightMax.InnerText = "720";
			_ = prodMax1.AppendChild(valueRadiusMax);
			_ = prodMax1.AppendChild(propertyScreenHeightMax);

			// Second <prod> for max
			XmlElement prodMax2 = doc.CreateElement("prod");
			XmlElement valueMaxSize = doc.CreateElement("value");
			valueMaxSize.InnerText = maxSize.ToString()!;
			XmlElement tanMax = doc.CreateElement("tan");
			XmlElement tanProdMax = doc.CreateElement("prod");
			XmlElement valueHalfMax = doc.CreateElement("value");
			valueHalfMax.InnerText = "0.5";
			XmlElement deg2radMax = doc.CreateElement("deg2rad");
			XmlElement fovPropertyMax = doc.CreateElement("property");
			fovPropertyMax.InnerText = "/sim/current-view/field-of-view";
			_ = deg2radMax.AppendChild(fovPropertyMax);
			_ = tanProdMax.AppendChild(valueHalfMax);
			_ = tanProdMax.AppendChild(deg2radMax);
			_ = tanMax.AppendChild(tanProdMax);
			_ = prodMax2.AppendChild(valueMaxSize);
			_ = prodMax2.AppendChild(tanMax);

			// Append to max property div
			_ = divMax.AppendChild(prodMax1);
			_ = divMax.AppendChild(prodMax2);
			_ = exprMax.AppendChild(divMax);
			_ = maxProp.AppendChild(exprMax);

			_ = lodElem.AppendChild(maxProp);
		}
		return lodElem;
	}

	protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
	{
		PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
	}

	private enum Flags
	{
		IsAboveAGL = 0,
		NoAutogenSuppression = 1,
		NoCrash = 2,
		NoFog = 3,
		NoShadow = 4,
		NoZWrite = 5,
		NoZTest = 6,
	}

#pragma warning disable CS0649
	private struct LibraryObject
	{
		public int id;
		public int size;
		public double longitude;
		public double latitude;
		public double altitude;
		public Flags[] flags;
		public double pitch;
		public double bank;
		public double heading;
		public int imageComplexity;
		public Guid guid;
		public double scale;
	}

	private struct LodData
	{
		public string name;
		public int minSize;
	}

	private struct ModelObject
	{
		public string name;
		public int minSize;
		public SceneBuilder model;
		public float radius;
	}

	private struct ModelData
	{
		public Guid guid;
		public string name;
		public List<ModelObject> modelObjects;
		public List<LightObject> lightObjects;
	}

	private struct ModelReference
	{
		public Guid guid;
		public string file;
		public int size;
		public int offset;
	}

	private struct LightObject
	{
		public string? name;
		public Vector3 position;
		public float pitchDeg;
		public float rollDeg;
		public float headingDeg;
		public Vector4 color;
		public float intensity;
		public float cutoffAngle;
		public float range_m;
		public float spot_exponent;
		public bool dayNightCycle;
		public float flashDuration;
		public float flashFrequency;
		public float flashPhase;
		public float rotationSpeed;
	}
#pragma warning restore CS0649
}