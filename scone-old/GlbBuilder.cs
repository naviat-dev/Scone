using System.Numerics;
using Newtonsoft.Json.Linq;
using SharpGLTF.Geometry;
using SharpGLTF.Geometry.VertexTypes;
using SharpGLTF.Materials;
using SharpGLTF.Scenes;

namespace Scone;

public class GlbBuilder
{
	public static readonly string DummyTexPath = Path.Combine(AppContext.BaseDirectory, "Assets", "dummy_tex.dds");
	public class PrimData
	{
		public Vector3[] Positions { get; set; } = [];
		public Vector3[] Normals { get; set; } = [];
		public List<Vector2[]> TexCoords { get; set; } = [];
		public Vector4[] Tangents { get; set; } = [];
		public Vector4[] Joints { get; set; } = [];
		public Vector4[] Weights { get; set; } = [];
		public int[] Indices { get; set; } = [];
	}

	private static int ComponentSize(int componentType)
	{
		return componentType switch
		{
			5120 => 1, // BYTE
			5121 => 1, // UNSIGNED_BYTE
			5122 => 2, // SHORT
			5123 => 2, // UNSIGNED_SHORT
			5125 => 4, // UNSIGNED_INT
			5126 => 4, // FLOAT
			_ => throw new Exception("Unknown componentType")
		};
	}
	private static int ComponentCount(string type)
	{
		return type switch
		{
			"SCALAR" => 1,
			"VEC2" => 2,
			"VEC3" => 3,
			"VEC4" => 4,
			_ => throw new Exception("Unsupported type")
		};
	}

	public static NodeBuilder BuildNode(int nodeIndex, JArray nodesJson)
	{
		JObject nodeJson = (JObject)nodesJson[nodeIndex];
		NodeBuilder node = new(nodeJson["name"]?.Value<string>() ?? $"Node_{nodeIndex}");
		// Apply transformations if present
		if (nodeJson["translation"] != null)
		{
			JArray translation = (JArray)nodeJson["translation"]!;
			_ = node.WithLocalTranslation(new Vector3(translation[0].Value<float>(), translation[1].Value<float>(), translation[2].Value<float>()));
		}
		if (nodeJson["rotation"] != null)
		{
			JArray rotation = (JArray)nodeJson["rotation"]!;
			_ = node.WithLocalRotation(new Quaternion(rotation[0].Value<float>(), rotation[1].Value<float>(), rotation[2].Value<float>(), rotation[3].Value<float>()));
		}
		if (nodeJson["scale"] != null)
		{
			JArray scale = (JArray)nodeJson["scale"]!;
			_ = node.WithLocalScale(new Vector3(scale[0].Value<float>(), scale[1].Value<float>(), scale[2].Value<float>()));
		}

		return node;
	}

	public static MeshBuilder<VertexPositionNormalTangent, VertexTexture2, VertexJoints8> BuildSkinnedMesh(string srcPath, string srcBgl, JObject meshJson, JArray accJson, JArray bvJson, JArray matsJson, JArray texJson, JArray imgJson, byte[] glbBinBytes)
	{

		MeshBuilder<VertexPositionNormalTangent, VertexTexture2, VertexJoints8> mesh = new(meshJson["name"]?.Value<string>() ?? "UnnamedMesh");
		foreach (JObject primJson in ((JArray)meshJson["primitives"]!).Cast<JObject>())
		{
			JObject matJson = (JObject)matsJson[primJson["material"]!.Value<int>()];
			if (matJson["extensions"]?["ASOBO_material_invisible"] != null || matJson["extensions"]?["ASOBO_material_environment_occluder"] != null)
			{
				continue;
			}
			PrimitiveBuilder<MaterialBuilder, VertexPositionNormalTangent, VertexTexture2, VertexJoints8> prim = mesh.UsePrimitive(BuildMaterial(matJson, texJson, imgJson, srcPath, srcBgl));
			JObject attributes = (JObject)primJson["attributes"]!;
			PrimData data = new();

			// Load indices
			int idxAccIndex = primJson["indices"]!.Value<int>();
			if (accJson.Count > idxAccIndex)
			{
				data.Indices = LoadIndexData((JObject)accJson[idxAccIndex], bvJson, glbBinBytes);
			}

			// Load positions
			int posAccIndex = attributes["POSITION"]!.Value<int>();
			if (accJson.Count > posAccIndex)
			{
				data.Positions = LoadPositionAccessorData((JObject)accJson[posAccIndex], bvJson, glbBinBytes);
			}

			// Load normals
			int normAccIndex = attributes["NORMAL"]!.Value<int>();
			if (accJson.Count > normAccIndex)
			{
				data.Normals = LoadNormalAccessorData((JObject)accJson[normAccIndex], bvJson, glbBinBytes);
			}

			// Load tangents
			int tangAccIndex = attributes["TANGENT"]!.Value<int>();
			if (accJson.Count > tangAccIndex)
			{
				data.Tangents = LoadTangentAccessorData((JObject)accJson[tangAccIndex], bvJson, glbBinBytes);
			}

			// Load all texture coordinate sets
			for (int texCoordIndex = 0; texCoordIndex < 2; texCoordIndex++)
			{
				string texCoordKey = $"TEXCOORD_{texCoordIndex}";
				if (attributes[texCoordKey] != null)
				{
					int uvAccIndex = (int)attributes[texCoordKey]!;
					if (accJson.Count > uvAccIndex)
					{
						data.TexCoords.Add(LoadTexCoordAccessorData((JObject)accJson[uvAccIndex], bvJson, glbBinBytes));
					}
				}
				else
				{
					break; // Stop when we hit the first missing TEXCOORD_N
				}
			}

			int jointAccIndex = attributes["JOINTS_0"]?.Value<int>() ?? -1;
			if (accJson.Count > jointAccIndex && jointAccIndex >= 0)
			{
				data.Joints = LoadJointAccessorData((JObject)accJson[jointAccIndex], bvJson, glbBinBytes);
			}

			int weightAccIndex = attributes["WEIGHTS_0"]?.Value<int>() ?? -1;
			if (accJson.Count > weightAccIndex && weightAccIndex >= 0)
			{
				data.Weights = LoadWeightAccessorData((JObject)accJson[weightAccIndex], bvJson, glbBinBytes);
			}

			// Load materials
			int materialIndex = primJson["material"]!.Value<int>();
			if (materialIndex >= 0)
			{
				// For simplicity, using a default material here.
				// In a full implementation, you would load the material properties from the glTF file.
				// prim.SetMaterial(MaterialBuilder.CreateDefault());
			}

			int baseVertex = primJson["extras"]?["ASOBO_primitive"]?["BaseVertexIndex"]?.Value<int>() ?? 0;
			int startIndex = primJson["extras"]?["ASOBO_primitive"]?["StartIndex"]?.Value<int>() ?? 0;
			int primCount = primJson["extras"]?["ASOBO_primitive"]?["PrimitiveCount"]?.Value<int>() ?? 0;

			for (int i = 0; i < primCount; i++)
			{
				int idx1 = baseVertex + data.Indices[startIndex + (i * 3)];
				int idx2 = baseVertex + data.Indices[startIndex + (i * 3) + 1];
				int idx3 = baseVertex + data.Indices[startIndex + (i * 3) + 2];

				VertexPositionNormalTangent geo1 = new(data.Positions[idx1], -data.Normals[idx1], data.Tangents.Length > 0 ? -data.Tangents[idx1] : Vector4.Zero);
				VertexPositionNormalTangent geo2 = new(data.Positions[idx2], -data.Normals[idx2], data.Tangents.Length > 0 ? -data.Tangents[idx2] : Vector4.Zero);
				VertexPositionNormalTangent geo3 = new(data.Positions[idx3], -data.Normals[idx3], data.Tangents.Length > 0 ? -data.Tangents[idx3] : Vector4.Zero);

				VertexJoints8 joints1 = BuildJointBindings(data, idx1);
				VertexJoints8 joints2 = BuildJointBindings(data, idx2);
				VertexJoints8 joints3 = BuildJointBindings(data, idx3);

				MaterialBuilder mat = MaterialBuilder.CreateDefault();

				Vector2 uv0_1 = data.TexCoords.Count > 0 ? data.TexCoords[0][idx1] : Vector2.Zero;
				Vector2 uv0_2 = data.TexCoords.Count > 0 ? data.TexCoords[0][idx2] : Vector2.Zero;
				Vector2 uv0_3 = data.TexCoords.Count > 0 ? data.TexCoords[0][idx3] : Vector2.Zero;

				Vector2 uv1_1 = data.TexCoords.Count > 1 ? data.TexCoords[1][idx1] : Vector2.Zero;
				Vector2 uv1_2 = data.TexCoords.Count > 1 ? data.TexCoords[1][idx2] : Vector2.Zero;
				Vector2 uv1_3 = data.TexCoords.Count > 1 ? data.TexCoords[1][idx3] : Vector2.Zero;

				VertexTexture2 mat1 = new(uv0_1, uv1_1);
				VertexTexture2 mat2 = new(uv0_2, uv1_2);
				VertexTexture2 mat3 = new(uv0_3, uv1_3);

				VertexBuilder<VertexPositionNormalTangent, VertexTexture2, VertexJoints8> v1 = new(geo1, mat1, joints1);
				VertexBuilder<VertexPositionNormalTangent, VertexTexture2, VertexJoints8> v2 = new(geo2, mat2, joints2);
				VertexBuilder<VertexPositionNormalTangent, VertexTexture2, VertexJoints8> v3 = new(geo3, mat3, joints3);

				_ = prim.AddTriangle(v1, v3, v2); // This has got to be inverted for normals
			}
		}
		return mesh;
	}

	public static MeshBuilder<VertexPositionNormalTangent, VertexTexture2, VertexEmpty> BuildMesh(string srcPath, string srcBgl, JObject meshJson, JArray accJson, JArray bvJson, JArray matsJson, JArray texJson, JArray imgJson, byte[] glbBinBytes)
	{
		MeshBuilder<VertexPositionNormalTangent, VertexTexture2, VertexJoints8> skinnedMesh = BuildSkinnedMesh(srcPath, srcBgl, meshJson, accJson, bvJson, matsJson, texJson, imgJson, glbBinBytes);
		MeshBuilder<VertexPositionNormalTangent, VertexTexture2, VertexEmpty> mesh = new(meshJson["name"]?.Value<string>() ?? "UnnamedMesh");
		mesh.AddMesh(skinnedMesh, material => material, VertexBuilder<VertexPositionNormalTangent, VertexTexture2, VertexEmpty>.CreateFrom);
		return mesh;
	}

	private static VertexJoints8 BuildJointBindings(PrimData data, int idx)
	{
		if (data.Joints.Length == 0 || data.Weights.Length == 0)
		{
			// Bind everything to joint 0 with full weight; SharpGLTF requires non-zero weights summing to 1.
			return new VertexJoints8((0, 1f));
		}
		Vector4 j = data.Joints[idx];
		Vector4 w = data.Weights[idx];
		// Drop bindings with zero weight (SparseWeight8 will normalize what remains).
		List<(int, float)> bindings = new(4);
		if (w.X > 0f) bindings.Add(((int)j.X, w.X));
		if (w.Y > 0f) bindings.Add(((int)j.Y, w.Y));
		if (w.Z > 0f) bindings.Add(((int)j.Z, w.Z));
		if (w.W > 0f) bindings.Add(((int)j.W, w.W));
		if (bindings.Count == 0)
		{
			bindings.Add(((int)j.X, 1f));
		}
		return new VertexJoints8([.. bindings]);
	}

	private static MaterialBuilder BuildMaterial(JObject matJson, JArray texJson, JArray imgJson, string srcPath, string sourceBgl)
	{
		MaterialBuilder material = new(matJson["name"]?.Value<string>() ?? "UnnamedMaterial")
		{
			AlphaMode = matJson["alphaMode"]?.Value<string>() switch
			{
				"BLEND" => AlphaMode.BLEND,
				"MASK" => AlphaMode.MASK,
				_ => AlphaMode.OPAQUE,
			},
			DoubleSided = matJson["doubleSided"]?.Value<bool>() ?? false,
			Extras = new System.Text.Json.Nodes.JsonObject()
		};
		if (matJson["pbrMetallicRoughness"] != null)
		{
			JObject pbr = (JObject)matJson["pbrMetallicRoughness"]!;
			if (pbr["baseColorFactor"] != null)
			{
				JArray colorFactor = (JArray)pbr["baseColorFactor"]!;
				_ = material.WithBaseColor(new Vector4(Math.Clamp(colorFactor[0].Value<float>(), 0f, 1f),
													Math.Clamp(colorFactor[1].Value<float>(), 0f, 1f),
													Math.Clamp(colorFactor[2].Value<float>(), 0f, 1f),
													Math.Clamp(colorFactor[3].Value<float>(), 0f, 1f)));
			}
			if (pbr["baseColorTexture"] != null)
			{
				int texIndex = pbr["baseColorTexture"]!["index"]!.Value<int>();
				int texCoordSet = pbr["baseColorTexture"]!["texCoord"]?.Value<int>() ?? 0;
				string mostLikelyMatch = "";
				if (texIndex >= 0 && texIndex < texJson.Count)
				{
					string imgUri = imgJson[texJson[texIndex]["extensions"]!["MSFT_texture_dds"]!["source"]!.Value<int>()]["uri"]!.Value<string>()?.Split('\\').Last()?.Split('/').Last() ?? "";
					if (imgUri != null)
					{
						string[] imageMatches = [.. Directory.GetFiles(srcPath, "*", SearchOption.AllDirectories).Where(f => string.Equals(Path.GetFileName(f), imgUri, StringComparison.OrdinalIgnoreCase))];
						int mostLikelyMatchScore = -1;
						foreach (string match in imageMatches)
						{
							int i = 0;

							while (i < Math.Min(match.Length, sourceBgl.Length) && match[i] == sourceBgl[i])
								i++;

							if (i > mostLikelyMatchScore)
							{
								mostLikelyMatchScore = i;
								mostLikelyMatch = match;
							}
						}
					}

					if (!string.IsNullOrEmpty(mostLikelyMatch))
					{
						material.Extras["baseColorTexture"] = mostLikelyMatch;
						_ = material.UseChannel(KnownChannel.BaseColor)
							.UseTexture()
							.WithPrimaryImage(DummyTexPath)
							.WithCoordinateSet(texCoordSet);
					}
				}
			}
			// Use sane defaults per glTF PBR: metallic=0 (non-metal), roughness=1 (fully rough)
			float metallic = Math.Clamp(pbr["metallicFactor"]?.Value<float>() ?? 0f, 0f, 1f);
			float roughness = Math.Clamp(pbr["roughnessFactor"]?.Value<float>() ?? 1f, 0f, 1f);
			_ = material.WithMetallicRoughness(metallic, roughness);
			if (pbr["metallicRoughnessTexture"] != null)
			{
				int texIndex = pbr["metallicRoughnessTexture"]!["index"]!.Value<int>();
				int texCoordSet = pbr["metallicRoughnessTexture"]!["texCoord"]?.Value<int>() ?? 0;
				string mostLikelyMatch = "";
				if (texIndex >= 0 && texIndex < texJson.Count)
				{
					string imgUri = imgJson[texJson[texIndex]["extensions"]!["MSFT_texture_dds"]!["source"]!.Value<int>()]["uri"]!.Value<string>()?.Split('\\').Last()?.Split('/').Last() ?? "";
					if (imgUri != null)
					{
						string[] imageMatches = [.. Directory.GetFiles(srcPath, "*", SearchOption.AllDirectories).Where(f => string.Equals(Path.GetFileName(f), imgUri, StringComparison.OrdinalIgnoreCase))];
						int mostLikelyMatchScore = -1;
						foreach (string match in imageMatches)
						{
							int i = 0;

							while (i < Math.Min(match.Length, sourceBgl.Length) && match[i] == sourceBgl[i])
								i++;

							if (i > mostLikelyMatchScore)
							{
								mostLikelyMatchScore = i;
								mostLikelyMatch = match;
							}
						}
					}


					if (!string.IsNullOrEmpty(mostLikelyMatch))
					{
						material.Extras["metallicRoughnessTexture"] = mostLikelyMatch;
						_ = material.UseChannel(KnownChannel.MetallicRoughness)
							.UseTexture()
							.WithPrimaryImage(DummyTexPath)
							.WithCoordinateSet(texCoordSet);
					}
				}
			}
		}
		if (matJson["normalTexture"] != null)
		{
			int texIndex = matJson["normalTexture"]!["index"]!.Value<int>();
			int texCoordSet = matJson["normalTexture"]!["texCoord"]?.Value<int>() ?? 0;
			string mostLikelyMatch = "";
			if (texIndex >= 0 && texIndex < imgJson.Count)
			{
				string imgUri = imgJson[texJson[texIndex]["extensions"]!["MSFT_texture_dds"]!["source"]!.Value<int>()]["uri"]!.Value<string>()?.Split('\\').Last()?.Split('/').Last() ?? "";
				if (imgUri != null)
				{
					string[] imageMatches = [.. Directory.GetFiles(srcPath, "*", SearchOption.AllDirectories).Where(f => string.Equals(Path.GetFileName(f), imgUri, StringComparison.OrdinalIgnoreCase))];
					int mostLikelyMatchScore = -1;
					foreach (string match in imageMatches)
					{
						int i = 0;

						while (i < Math.Min(match.Length, sourceBgl.Length) && match[i] == sourceBgl[i])
							i++;

						if (i > mostLikelyMatchScore)
						{
							mostLikelyMatchScore = i;
							mostLikelyMatch = match;
						}
					}
				}

				if (!string.IsNullOrEmpty(mostLikelyMatch))
				{
					material.Extras["normalTexture"] = mostLikelyMatch;
					_ = material.UseChannel(KnownChannel.Normal)
						.UseTexture()
						.WithPrimaryImage(DummyTexPath)
						.WithCoordinateSet(texCoordSet);
				}
			}
		}
		if (matJson["occlusionTexture"] != null)
		{
			int texIndex = matJson["occlusionTexture"]!["index"]!.Value<int>();
			int texCoordSet = matJson["occlusionTexture"]!["texCoord"]?.Value<int>() ?? 0;
			string mostLikelyMatch = "";
			if (texIndex >= 0 && texIndex < imgJson.Count)
			{
				string imgUri = imgJson[texJson[texIndex]["extensions"]!["MSFT_texture_dds"]!["source"]!.Value<int>()]["uri"]!.Value<string>()?.Split('\\').Last()?.Split('/').Last() ?? "";
				if (imgUri != null)
				{
					string[] imageMatches = [.. Directory.GetFiles(srcPath, "*", SearchOption.AllDirectories).Where(f => string.Equals(Path.GetFileName(f), imgUri, StringComparison.OrdinalIgnoreCase))];
					int mostLikelyMatchScore = -1;
					foreach (string match in imageMatches)
					{
						int i = 0;

						while (i < Math.Min(match.Length, sourceBgl.Length) && match[i] == sourceBgl[i])
							i++;

						if (i > mostLikelyMatchScore)
						{
							mostLikelyMatchScore = i;
							mostLikelyMatch = match;
						}
					}
				}

				if (!string.IsNullOrEmpty(mostLikelyMatch))
				{
					material.Extras["occlusionTexture"] = mostLikelyMatch;
					_ = material.UseChannel(KnownChannel.Occlusion)
						.UseTexture()
						.WithPrimaryImage(DummyTexPath)
						.WithCoordinateSet(texCoordSet);
				}
			}
		}
		if (matJson["emissiveTexture"] != null)
		{
			int texIndex = matJson["emissiveTexture"]!["index"]!.Value<int>();
			int texCoordSet = matJson["emissiveTexture"]!["texCoord"]?.Value<int>() ?? 0;
			string mostLikelyMatch = "";
			if (texIndex >= 0 && texIndex < imgJson.Count)
			{
				string imgUri = imgJson[texJson[texIndex]["extensions"]!["MSFT_texture_dds"]!["source"]!.Value<int>()]["uri"]!.Value<string>()?.Split('\\').Last()?.Split('/').Last() ?? "";
				if (imgUri != null)
				{
					string[] imageMatches = [.. Directory.GetFiles(srcPath, "*", SearchOption.AllDirectories).Where(f => string.Equals(Path.GetFileName(f), imgUri, StringComparison.OrdinalIgnoreCase))];
					int mostLikelyMatchScore = -1;
					foreach (string match in imageMatches)
					{
						int i = 0;

						while (i < Math.Min(match.Length, sourceBgl.Length) && match[i] == sourceBgl[i])
							i++;

						if (i > mostLikelyMatchScore)
						{
							mostLikelyMatchScore = i;
							mostLikelyMatch = match;
						}
					}
				}

				if (!string.IsNullOrEmpty(mostLikelyMatch))
				{
					material.Extras["emissiveTexture"] = mostLikelyMatch;
					_ = material.UseChannel(KnownChannel.Emissive)
						.UseTexture()
						.WithPrimaryImage(DummyTexPath)
						.WithCoordinateSet(texCoordSet);
				}
			}
		}
		if (matJson["emissiveFactor"] != null)
		{
			JArray emissiveFactor = (JArray)matJson["emissiveFactor"]!;
			_ = material.WithEmissive(new Vector3(Math.Clamp(emissiveFactor[0].Value<float>(), 0f, 1f),
											  Math.Clamp(emissiveFactor[1].Value<float>(), 0f, 1f),
											  Math.Clamp(emissiveFactor[2].Value<float>(), 0f, 1f)));
		}
		// Additional material properties can be set here based on the glTF material definition
		return material;
	}

	private static Vector3[] LoadNormalAccessorData(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();

		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];

		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;

		int componentType = accessorJson["componentType"]!.Value<int>(); // should be 5120 (BYTE)
		string? type = accessorJson["type"]!.Value<string>();            // should be "VEC4"

		int componentSize = ComponentSize(componentType);  // for byte: 1
		int numComponents = ComponentCount(type!);         // for VEC4: 4

		// Convert from VEC4 BYTE to VEC3 FLOAT
		Vector3[] normals = new Vector3[count];

		int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * numComponents); // if byteStride is absent, assume packed data

		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewByteOffset + accessorByteOffset + (i * stride);

			normals[i] = new Vector3((sbyte)binBytes[offset + (0 * componentSize)],
									 (sbyte)binBytes[offset + (1 * componentSize)],
									 (sbyte)binBytes[offset + (2 * componentSize)]);
		}

		return normals;
	}

	private static Vector3[] LoadPositionAccessorData(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();

		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];

		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;

		int componentType = accessorJson["componentType"]!.Value<int>(); // should be 5126 (FLOAT)
		string? type = accessorJson["type"]!.Value<string>();            // should be "VEC3"

		int componentSize = ComponentSize(componentType);  // for float: 4
		int numComponents = ComponentCount(type!);         // for VEC3: 3

		Vector3[] positions = new Vector3[count];

		int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * numComponents);

		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewByteOffset + accessorByteOffset + (i * stride);

			positions[i] = new Vector3(BitConverter.ToSingle(binBytes, offset + (0 * componentSize)),
								   BitConverter.ToSingle(binBytes, offset + (1 * componentSize)),
								   BitConverter.ToSingle(binBytes, offset + (2 * componentSize)));
		}

		return positions;
	}

	private static Vector4[] LoadTangentAccessorData(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();

		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];

		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;

		int componentType = accessorJson["componentType"]!.Value<int>(); // should be 5120 (BYTE)
		string? type = accessorJson["type"]!.Value<string>();            // should be "VEC4"

		int componentSize = ComponentSize(componentType);  // for byte: 1
		int numComponents = ComponentCount(type!);         // for VEC4: 4

		// Convert from VEC4 BYTE to VEC4 FLOAT
		Vector4[] tangents = new Vector4[count];

		int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * numComponents);

		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewByteOffset + accessorByteOffset + (i * stride);

			tangents[i] = new Vector4((sbyte)binBytes[offset + (0 * componentSize)],
								  (sbyte)binBytes[offset + (1 * componentSize)],
								  (sbyte)binBytes[offset + (2 * componentSize)],
								  (sbyte)binBytes[offset + (3 * componentSize)]);
		}

		return tangents;
	}

	private static int[] LoadIndexData(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();

		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];

		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;

		int componentType = accessorJson["componentType"]!.Value<int>(); // 5123 (UNSIGNED_SHORT) or 5125 (UNSIGNED_INT)

		int componentSize = ComponentSize(componentType);  // 2 for UNSIGNED_SHORT, 4 for UNSIGNED_INT

		int[] indices = new int[count];

		int stride = componentSize;

		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewByteOffset + accessorByteOffset + (i * stride);

			if (componentType == 5123) // UNSIGNED_SHORT
			{
				indices[i] = BitConverter.ToUInt16(binBytes, offset);
			}
			else if (componentType == 5125) // UNSIGNED_INT
			{
				// Cast down to int safely
				indices[i] = (int)BitConverter.ToUInt32(binBytes, offset);
			}
			else
			{
				throw new Exception($"Unsupported index componentType: {componentType}");
			}
		}

		return indices;
	}

	private static Vector2[] LoadTexCoordAccessorData(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();

		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];

		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;

		int componentType = accessorJson["componentType"]!.Value<int>();
		string? type = accessorJson["type"]!.Value<string>();

		int componentSize = ComponentSize(componentType);
		int numComponents = ComponentCount(type!);

		Vector2[] texCoords = new Vector2[count];

		int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * numComponents);

		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewByteOffset + accessorByteOffset + (i * stride);

			// Read as half-precision float (16-bit float) - component type 5122 (SHORT) is used to indicate float16
			Half u = BitConverter.ToHalf(binBytes, offset + (0 * componentSize));
			Half v = BitConverter.ToHalf(binBytes, offset + (1 * componentSize));

			texCoords[i] = new Vector2((float)u, 1f - (float)v);
		}

		return texCoords;
	}

	private static Vector4[] LoadJointAccessorData(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();

		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];

		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;

		int componentType = accessorJson["componentType"]!.Value<int>();
		string? type = accessorJson["type"]!.Value<string>();

		int componentSize = ComponentSize(componentType);
		int numComponents = ComponentCount(type!);

		Vector4[] joints = new Vector4[count];

		int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * numComponents);

		// glTF spec: JOINTS_n is UNSIGNED_BYTE (5121) or UNSIGNED_SHORT (5123).
		// Asobo MSFS GLBs may report a different componentType; treat anything that isn't a
		// 16-bit unsigned value as 4-byte UNSIGNED_BYTE packing (which matches the layout used
		// by Asobo for sub-256 joint counts).
		bool unsignedShort = componentType == 5123;
		if (componentType != 5121 && componentType != 5123)
		{
			// Fall back to UNSIGNED_BYTE-style read with a 4-byte stride.
			stride = 4;
		}

		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewByteOffset + accessorByteOffset + (i * stride);

			float c0, c1, c2, c3;
			if (unsignedShort) // UNSIGNED_SHORT
			{
				c0 = BitConverter.ToUInt16(binBytes, offset + 0);
				c1 = BitConverter.ToUInt16(binBytes, offset + 2);
				c2 = BitConverter.ToUInt16(binBytes, offset + 4);
				c3 = BitConverter.ToUInt16(binBytes, offset + 6);
			}
			else // UNSIGNED_BYTE (or fallback)
			{
				c0 = binBytes[offset + 0];
				c1 = binBytes[offset + 1];
				c2 = binBytes[offset + 2];
				c3 = binBytes[offset + 3];
			}
			joints[i] = new Vector4(c0, c1, c2, c3);
		}

		return joints;
	}

	private static Vector4[] LoadWeightAccessorData(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();

		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];

		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;

		int componentType = accessorJson["componentType"]!.Value<int>();
		string? type = accessorJson["type"]!.Value<string>();

		int componentSize = ComponentSize(componentType);
		int numComponents = ComponentCount(type!);

		Vector4[] weights = new Vector4[count];

		int declaredStride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * numComponents);
		int declaredElementSize = componentSize * numComponents;

		// glTF spec: WEIGHTS_n is FLOAT, normalized UNSIGNED_BYTE, or normalized UNSIGNED_SHORT.
		// Asobo MSFS GLBs sometimes lie about componentType (declare FLOAT but actually pack as
		// 4-byte normalized UNSIGNED_BYTE per vertex). Detect that by checking whether the declared
		// 16-byte FLOAT layout actually fits the bufferView length / BIN chunk; if not, fall back
		// to a byte-packed interpretation with a 4-byte stride.
		bool asoboPackedAsBytes = false;
		if (componentType == 5126)
		{
			int? bufferViewByteLength = bufferView["byteLength"]?.Value<int>();
			long lastFloatEnd = (long)bufferViewByteOffset + accessorByteOffset + ((long)(count - 1) * declaredStride) + declaredElementSize;
			long requiredFromBvOffset = (long)accessorByteOffset + ((long)count * declaredStride);
			if (declaredStride < declaredElementSize
				|| lastFloatEnd > binBytes.Length
				|| (bufferViewByteLength.HasValue && requiredFromBvOffset > bufferViewByteLength.Value))
			{
				asoboPackedAsBytes = true;
			}
		}

		int stride = asoboPackedAsBytes ? 4 : declaredStride;

		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewByteOffset + accessorByteOffset + (i * stride);

			float w0, w1, w2, w3;
			if (componentType == 5126 && !asoboPackedAsBytes) // FLOAT
			{
				w0 = BitConverter.ToSingle(binBytes, offset + 0);
				w1 = BitConverter.ToSingle(binBytes, offset + 4);
				w2 = BitConverter.ToSingle(binBytes, offset + 8);
				w3 = BitConverter.ToSingle(binBytes, offset + 12);
			}
			else if (componentType == 5121 || asoboPackedAsBytes) // UNSIGNED_BYTE normalized
			{
				w0 = binBytes[offset + 0] / 255f;
				w1 = binBytes[offset + 1] / 255f;
				w2 = binBytes[offset + 2] / 255f;
				w3 = binBytes[offset + 3] / 255f;
			}
			else if (componentType == 5123) // UNSIGNED_SHORT normalized
			{
				w0 = BitConverter.ToUInt16(binBytes, offset + 0) / 65535f;
				w1 = BitConverter.ToUInt16(binBytes, offset + 2) / 65535f;
				w2 = BitConverter.ToUInt16(binBytes, offset + 4) / 65535f;
				w3 = BitConverter.ToUInt16(binBytes, offset + 6) / 65535f;
			}
			else
			{
				throw new Exception($"Unsupported WEIGHTS_0 componentType: {componentType}");
			}
			weights[i] = new Vector4(w0, w1, w2, w3);
		}

		return weights;
	}

	internal static Matrix4x4[] LoadInverseBindMatrices(JObject accessorJson, JArray bufferViewsJson, byte[] binBytes)
	{
		int count = accessorJson["count"]!.Value<int>();
		JObject bufferView = (JObject)bufferViewsJson[accessorJson["bufferView"]!.Value<int>()];
		int accessorByteOffset = accessorJson["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
		int stride = bufferView["byteStride"]?.Value<int>() ?? (16 * 4);
		Matrix4x4[] mats = new Matrix4x4[count];
		for (int i = 0; i < count; i++)
		{
			int o = bufferViewByteOffset + accessorByteOffset + (i * stride);
			mats[i] = new Matrix4x4(
				BitConverter.ToSingle(binBytes, o + 0),  BitConverter.ToSingle(binBytes, o + 4),  BitConverter.ToSingle(binBytes, o + 8),  BitConverter.ToSingle(binBytes, o + 12),
				BitConverter.ToSingle(binBytes, o + 16), BitConverter.ToSingle(binBytes, o + 20), BitConverter.ToSingle(binBytes, o + 24), BitConverter.ToSingle(binBytes, o + 28),
				BitConverter.ToSingle(binBytes, o + 32), BitConverter.ToSingle(binBytes, o + 36), BitConverter.ToSingle(binBytes, o + 40), BitConverter.ToSingle(binBytes, o + 44),
				BitConverter.ToSingle(binBytes, o + 48), BitConverter.ToSingle(binBytes, o + 52), BitConverter.ToSingle(binBytes, o + 56), BitConverter.ToSingle(binBytes, o + 60)
			);
		}
		return mats;
	}
}