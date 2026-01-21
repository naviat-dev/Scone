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
	private int _bytesTotal = 0;
	public int BytesTotal
	{
		get => _bytesTotal;
		private set
		{
			_bytesTotal = value;
			OnPropertyChanged();
		}
	}
	
	private int _bytesProcessed = 0;
	public int BytesProcessed
	{
		get => _bytesProcessed;
		private set
		{
			_bytesProcessed = value;
			OnPropertyChanged();
		}
	}
	
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
	public event PropertyChangedEventHandler? PropertyChanged;
	private readonly MemoryImage Fallback = new("Assets\\tex-fallback.png");
	public void ConvertScenery(string inputPath, string outputPath)
	{
		if (!Directory.Exists(inputPath))
		{
			Console.WriteLine("Input path does not exist.");
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
				Console.WriteLine("Invalid BGL header");
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
						Console.WriteLine($"Unexpected subrecord type at offset 0x{subOffset + bytesRead:X}: 0x{id:X4}, skipping {skip} bytes");
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
					Status = Status = $"Looking for placements in {Path.GetFileName(file)}... found {totalLibraryObjects}";
					libraryObjects[guid].Add(libObj);
					Console.WriteLine($"{guid}\t{libObj.size}\t{libObj.longitude:F6}\t{libObj.latitude:F6}\t{libObj.altitude}\t[{string.Join(",", libObj.flags)}]\t{libObj.pitch:F2}\t{libObj.bank:F2}\t{libObj.heading:F2}\t{libObj.imageComplexity}\t{libObj.scale}");
					bytesRead += size;
				}
			}
		}

		// Models need to be written combined on a tile-by-tile basis to minimize RAM consumption
		// We have all the placements and their GUIDs, so run through the model BGLs and create a Dictionary
		// The key will be the tile index, and the value will be a list of access points of models (file, binary address, size)
		// After the dictionary has been completed, we will go back through and write out each tile's models to the respective folder

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
				Console.WriteLine("Invalid BGL header");
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
					BytesProcessed += 16;
					Guid guid = new(guidBytes);
					uint startModelDataOffset = br.ReadUInt32();
					uint modelDataSize = br.ReadUInt32();
					if (!libraryObjects.ContainsKey(guid))
					{
						bytesRead += (int)modelDataSize + 24;
						objectsRead++;
						continue;
					}
					_ = br.BaseStream.Seek(subOffset + startModelDataOffset, SeekOrigin.Begin);
					byte[] mdlBytes = br.ReadBytes((int)modelDataSize);
					string name = "";
					List<LodData> lods = [];
					List<LightObject> lightObjects = [];
					string chunkID = Encoding.ASCII.GetString(mdlBytes, 0, Math.Min(4, mdlBytes.Length));
					if (chunkID != "RIFF")
					{
						break;
					}
					if (libraryObjects.TryGetValue(guid, out List<LibraryObject>? value))
					{
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
									Console.WriteLine($"Failed to parse GXML for model {guid:X}");
								}
								i += size;
							}
							else if (chunk == "GLBD")
							{
								Console.WriteLine($"Processing GLBD chunk for model {name} ({guid}) in {file}");
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
										byte[] glbBytesJson = mdlBytes[(j + 8)..(j + 8 + glbSize)]; // Copy this for additional safety in processing the JSON

										// Fill the end of the JSON chunk with spaces, and replace non-printable characters with spaces.
										uint JSONLength = BitConverter.ToUInt32(glbBytesJson, 0x0C);
										for (int k = 0x14; k < 0x14 + JSONLength; k++)
										{
											if (glbBytesJson[k] < 0x20 || glbBytesJson[k] > 0x7E)
											{
												glbBytesJson[k] = 0x20;
											}
										}

										uint binLength = BitConverter.ToUInt32(glbBytes, 0x14 + (int)JSONLength);
										byte[] glbBinBytes = glbBytes[(0x14 + (int)JSONLength + 8)..(0x14 + (int)JSONLength + 8 + (int)binLength)];

										JObject json = JObject.Parse(Encoding.UTF8.GetString(glbBytesJson, 0x14, (int)JSONLength).Trim());
										JArray meshes = (JArray)json["meshes"]!;
										JArray accessors = (JArray)json["accessors"]!;
										JArray bufferViews = (JArray)json["bufferViews"]!;
										JArray images = (JArray)json["images"]!;
										JArray materials = (JArray)json["materials"]!;
										JArray textures = (JArray)json["textures"]!;

										SceneBuilder scene = new();
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
											else if (node["extensions"]?["ASOBO_macro_light"] != null)
											{
												LightObject light = new()
												{
													name = node["name"]?.Value<string>() ?? "Unnamed_Light",
													position = new Vector3(
														node["translation"] != null ? node["translation"]![0]!.Value<float>() : 0,
														node["translation"] != null ? node["translation"]![1]!.Value<float>() : 0,
														node["translation"] != null ? node["translation"]![2]!.Value<float>() : 0),

													pitchDeg = node["rotation"] != null ? MathF.Asin(Math.Clamp(2 * (node["rotation"]![1]!.Value<float>() * node["rotation"]![3]!.Value<float>() - node["rotation"]![0]!.Value<float>() * node["rotation"]![2]!.Value<float>()), -1f, 1f)) * (180.0f / MathF.PI) : 0,
													rollDeg = node["rotation"] != null ? MathF.Atan2(2 * (node["rotation"]![0]!.Value<float>() * node["rotation"]![3]!.Value<float>() + node["rotation"]![1]!.Value<float>() * node["rotation"]![2]!.Value<float>()), 1 - 2 * (node["rotation"]![0]!.Value<float>() * node["rotation"]![0]!.Value<float>() + node["rotation"]![1]!.Value<float>() * node["rotation"]![1]!.Value<float>())) * (180.0f / MathF.PI) : 0,
													headingDeg = node["rotation"] != null ? MathF.Atan2(2 * (node["rotation"]![2]!.Value<float>() * node["rotation"]![3]!.Value<float>() + node["rotation"]![0]!.Value<float>() * node["rotation"]![1]!.Value<float>()), 1 - 2 * (node["rotation"]![1]!.Value<float>() * node["rotation"]![1]!.Value<float>() + node["rotation"]![2]!.Value<float>() * node["rotation"]![2]!.Value<float>())) * (180.0f / MathF.PI) : 0,
													color = new Vector4(
														node["extensions"]!["ASOBO_macro_light"]!["color"] != null ? node["extensions"]!["ASOBO_macro_light"]!["color"]![0]!.Value<float>() : 1,
														node["extensions"]!["ASOBO_macro_light"]!["color"] != null ? node["extensions"]!["ASOBO_macro_light"]!["color"]![1]!.Value<float>() : 1,
														node["extensions"]!["ASOBO_macro_light"]!["color"] != null ? node["extensions"]!["ASOBO_macro_light"]!["color"]![2]!.Value<float>() : 1,
														1),
													intensity = node["extensions"]!["ASOBO_macro_light"]!["intensity"] != null ? node["extensions"]!["ASOBO_macro_light"]!["intensity"]!.Value<float>() : 1,
													cutoffAngle = node["extensions"]!["ASOBO_macro_light"]!["cone_angle"] != null ? node["extensions"]!["ASOBO_macro_light"]!["cone_angle"]!.Value<float>() : 45,
													dayNightCycle = node["extensions"]!["ASOBO_macro_light"]!["day_night_cycle"] != null && node["extensions"]!["ASOBO_macro_light"]!["day_night_cycle"]!.Value<bool>(),
													flashDuration = node["extensions"]!["ASOBO_macro_light"]!["flash_duration"] != null ? node["extensions"]!["ASOBO_macro_light"]!["flash_duration"]!.Value<float>() : 0,
													flashFrequency = node["extensions"]!["ASOBO_macro_light"]!["flash_frequency"] != null ? node["extensions"]!["ASOBO_macro_light"]!["flash_frequency"]!.Value<float>() : 0,
													flashPhase = node["extensions"]!["ASOBO_macro_light"]!["flash_phase"] != null ? node["extensions"]!["ASOBO_macro_light"]!["flash_phase"]!.Value<float>() : 0,
													rotationSpeed = node["extensions"]!["ASOBO_macro_light"]!["rotation_speed"] != null ? node["extensions"]!["ASOBO_macro_light"]!["rotation_speed"]!.Value<float>() : 0,
												};

												if (light.cutoffAngle / 2.0f < 90.0f && light.cutoffAngle / 2.0f > 0.0f)
												{
													// Tunable constants:
													float kBase = 0.1f;    // attenuation base constant
													float visibleFraction = 0.01f;  // threshold (1%)
													float eMin = 1.0f;    // minimum exponent
													float eMax = 128.0f;  // maximum exponent
													float p = 2.0f;    // exponent shaping power

													//-----------------------------------------
													// RANGE (meters)
													//-----------------------------------------
													float I0 = Math.Max(1e-6f, light.intensity);
													float kq = kBase / I0;                        // quadratic attenuation coefficient

													float f = Math.Clamp(visibleFraction, 1e-6f, 0.999f);

													light.range_m = (float)Math.Sqrt(((1.0f / f) - 1.0f) / kq);

													// n = normalized tightness factor (0..1)
													float n = 1.0f - (light.cutoffAngle / 45.0f);
													n = Math.Clamp(n, 0.0f, 1.0f);

													// Focus exponent mapping
													light.spot_exponent = eMin + (float)Math.Pow(n, p) * (eMax - eMin);
													light.spot_exponent = Math.Clamp(light.spot_exponent, eMin, eMax);
												}
												lightObjects.Add(light);
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
												current = parentMap[current.Value] >= 0 ? parentMap[current.Value] : (int?)null;
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

										accessors = JObject.Parse(scene.ToGltf2().GetJsonPreview())["accessors"]?.Value<JArray>()!;
										Vector3 min = new(float.MaxValue);
										Vector3 max = new(float.MinValue);
										foreach (JObject accessor in accessors?.Cast<JObject>() ?? [])
										{
											if (accessor["min"] != null && accessor["max"] != null && accessor["name"]!.Value<string>() == "POSITION")
											{
												Vector3 accessorMin = new(
													accessor["min"]![0]!.Value<float>(),
													accessor["min"]![1]!.Value<float>(),
													accessor["min"]![2]!.Value<float>());
												Vector3 accessorMax = new(
													accessor["max"]![0]!.Value<float>(),
													accessor["max"]![1]!.Value<float>(),
													accessor["max"]![2]!.Value<float>());

												min = Vector3.Min(min, accessorMin);
												max = Vector3.Max(max, accessorMax);
											}
										}
										// Write GLB with unique filename (include index to avoid overwrites)
										string safeName = name;
										string outName = glbIndex < lods.Count ? lods[glbIndex].name : $"{safeName}_glb{glbIndex}";
										modelObjects.Add(new ModelObject
										{
											name = outName.Replace(" ", "_"),
											minSize = glbIndex < lods.Count ? lods[glbIndex].minSize : 0,
											model = scene,
											radius = (max - min).Length() / 2.0f,
										});
										glbIndex++;

										// Advance j past this GLB record (type[4] + size[4] + payload[glbSize])
										j += 8 + glbSize;
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
							bytesRead += (int)modelDataSize + 24;
							objectsRead++;
							continue;
						}
						ModelData current = new()
						{
							guid = guid,
							name = name,
							lightObjects = lightObjects,
							modelObjects = modelObjects,
						};
						int[] tileIndices = [.. value.Select(lo => Terrain.GetTileIndex(lo.latitude, lo.longitude)).Distinct()];
						foreach (int tile in tileIndices)
						{
							(double lat, double lon) = Terrain.GetLatLon(tile);
							string lonHemi = lon >= 0 ? "e" : "w";
							string latHemi = lat >= 0 ? "n" : "s";
							string path = $"{outputPath}/Objects/{lonHemi}{Math.Abs(Math.Floor(lon / 10)) * 10:000}{latHemi}{Math.Abs(Math.Floor(lat / 10)) * 10:00}/{lonHemi}{Math.Abs(Math.Floor(lon)):000}{latHemi}{Math.Abs(Math.Floor(lat)):00}";
							if (!Directory.Exists(path))
							{
								_ = Directory.CreateDirectory(path);
							}
							for (int i = 0; i < modelObjects.Count; i++)
							{
								ModelObject modelObj = modelObjects[i];
								modelObj.name = modelObjects.Count > 1 ? modelObj.name : name;
								modelObjects[i] = modelObj;
								string outGlbPath = Path.Combine(path, $"{modelObj.name}.gltf");
								modelObj.model.ToGltf2().SaveGLTF(outGlbPath, new WriteSettings
								{
									ImageWriting = ResourceWriteMode.SatelliteFile,
									ImageWriteCallback = (context, assetName, image) =>
									{
										string fileName = string.IsNullOrEmpty(image.SourcePath) ? assetName : image.SourcePath.Split(Path.DirectorySeparatorChar).Last();
										fileName = fileName.Replace(" ", "_");
										string finalPath = Path.Combine(path, fileName);

										// Only write the image once
										if (!File.Exists(finalPath) && !image.Content.Span.SequenceEqual(Fallback.Content.Span))
										{
											File.WriteAllBytes(finalPath, image.Content.ToArray());
										}

										// Return the URI that should appear in the glTF
										return fileName;
									}
								});
								// Reopen the gltf file to fix the texture problem.
								// This way isn't clean, but it's not messy and it works reliably.
								JObject gltfText = JObject.Parse(File.ReadAllText(outGlbPath));
								if (gltfText["textures"] != null)
								{
									foreach (JObject tex in gltfText["textures"]!.Cast<JObject>())
									{
										tex["source"] = tex["extensions"]?["MSFT_texture_dds"]?["source"];
									}
								}
								File.WriteAllText(outGlbPath, gltfText.ToString());
							}
							float[] scales = [.. libraryObjects[guid].Select(lo => (float)lo.scale).Distinct()];
							float[] scalesTrunc = [.. libraryObjects[guid].Where(lo => lo.scale != 1).Select(lo => (float)lo.scale).Distinct()];
							ModelObject[] modelObjectsByLod = [.. modelObjects.OrderByDescending(mo => mo.minSize)];
							bool hasXml = false;
							Console.WriteLine($"Object count: {modelObjects.Count}, Scales: {string.Join(", ", scales)}, Lights: {lightObjects?.Count ?? 0}");
							if (modelObjects.Count > 1 || scalesTrunc.Length > 0 || lightObjects?.Count > 0)
							{
								hasXml = true;
								foreach (float scale in scales)
								{
									XmlDocument doc = new();
									XmlElement root = doc.CreateElement("PropertyList");
									_ = root.AppendChild(doc.CreateComment("Generated by Scone"));
									for (int i = 0; i < modelObjects.Count; i++)
									{
										ModelObject modelObj = modelObjectsByLod[i];
										XmlElement objElem = doc.CreateElement("model");
										objElem.AppendChild(doc.CreateElement("name"))!.InnerText = modelObj.name;
										objElem.AppendChild(doc.CreateElement("path"))!.InnerText = $"{modelObj.name}.gltf";
										_ = root.AppendChild(objElem);
										if (modelObj.minSize > 0)
										{
											_ = root.AppendChild(CreateLodElement(doc, modelObj.radius, modelObj.minSize, i + 1 < modelObjectsByLod.Length ? modelObjectsByLod[i + 1].minSize : (int?)null));
										}
									}
									foreach (LightObject light in lightObjects!)
									{
										_ = root.AppendChild(CreateLightElement(doc, light));
									}
									if (scale != 1)
									{
										_ = root.AppendChild(CreateScaleElement(doc, scale, current));
									}
									File.WriteAllText(Path.Combine(path, $"{name}{(scale != 1 ? $"_{scale}" : string.Empty)}.xml"), root.OuterXml);
								}
							}
							if (!finalPlacementsByTile.ContainsKey(Terrain.GetTileIndex(value[0].latitude, value[0].longitude)))
							{
								finalPlacementsByTile[Terrain.GetTileIndex(value[0].latitude, value[0].longitude)] = [];
							}
							foreach (LibraryObject libObj in value)
							{
								string activeName = hasXml ? $"{name}{(libObj.scale != 1 ? $"_{libObj.scale}" : string.Empty)}.xml" : $"{name}.gltf";
								double headingStg = ((libObj.heading > 180 ? 540 : 180) - libObj.heading + 90) % 360;
								double bankStg = (libObj.bank + 90) % 360;
								string placementStr = $"OBJECT_STATIC {activeName} {libObj.longitude} {libObj.latitude} {libObj.altitude} {headingStg:F2} {libObj.pitch:F2} {bankStg:F2}";
								if (!finalPlacementsByTile.ContainsKey(Terrain.GetTileIndex(libObj.latitude, libObj.longitude)))
								{
									finalPlacementsByTile[Terrain.GetTileIndex(libObj.latitude, libObj.longitude)] = [];
								}
								finalPlacementsByTile[Terrain.GetTileIndex(libObj.latitude, libObj.longitude)].Add(placementStr);
							}
						}
					}
					else
					{
						Console.WriteLine($"No placements found for model {name} ({guid})");
					}
					bytesRead += (int)modelDataSize + 24;
					objectsRead++;
				}
			}

			// Write final placement files per tile
			foreach (var kvp in finalPlacementsByTile)
			{
				int tileIndex = kvp.Key;
				(double lat, double lon) = Terrain.GetLatLon(tileIndex);
				string lonHemi = lon >= 0 ? "e" : "w";
				string latHemi = lat >= 0 ? "n" : "s";
				string path = $"{outputPath}/Objects/{lonHemi}{Math.Abs(Math.Floor(lon / 10)) * 10:000}{latHemi}{Math.Abs(Math.Floor(lat / 10)) * 10:00}/{lonHemi}{Math.Abs(Math.Floor(lon)):000}{latHemi}{Math.Abs(Math.Floor(lat)):00}";
				if (!Directory.Exists(path))
				{
					_ = Directory.CreateDirectory(path);
				}
				string placementFilePath = Path.Combine(path, $"{tileIndex}.stg");
				File.WriteAllLines(placementFilePath, kvp.Value);
			}
		}
		Console.WriteLine("Conversion complete.");
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

	private struct ModelData
	{
		public Guid guid;
		public string name;
		public List<ModelObject> modelObjects;
		public List<LightObject> lightObjects;
	}
}