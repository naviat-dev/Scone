using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Text;
using Newtonsoft.Json.Linq;

namespace Scone;

/// <summary>
/// Builds AC3D scenes from MSFS glTF payloads.
/// </summary>
public sealed class AcBuilder
{
	private static readonly CultureInfo Culture = CultureInfo.InvariantCulture;
	private readonly List<AcMaterial> _materials = [];
	private readonly List<AcMeshObject> _objects = [];
	private readonly Dictionary<string, int> _materialCache = new(StringComparer.OrdinalIgnoreCase);
	private readonly Dictionary<string, string> _textureCopyTargets = new(StringComparer.OrdinalIgnoreCase);
	private readonly HashSet<string> _textureOutputNames = new(StringComparer.OrdinalIgnoreCase);
	private const float VertexQuantizationScale = 10000f;

	public string WorldName { get; set; } = "SconeExport";

	public IReadOnlyList<AcMeshObject> Objects => _objects;
	public IReadOnlyList<AcMaterial> Materials => _materials;

	public AcBuilder()
	{
		AcMaterial defaultMaterial = AcMaterial.CreateDefault();
		_materials.Add(defaultMaterial);
		_materialCache[defaultMaterial.CacheKey] = 0;
	}

	public static AcBuilder FromGltf(byte[] glbBinBytes, JObject json, string assetRoot, string sourceBgl)
	{
		AcBuilder builder = new();
		builder.AppendGltf(glbBinBytes, json, assetRoot, sourceBgl);
		return builder;
	}

	public void AppendGltf(byte[] glbBinBytes, JObject json, string assetRoot, string sourceBgl)
	{
		JArray meshes = (JArray?)json["meshes"] ?? [];
		if (meshes.Count == 0)
		{
			return;
		}
		JArray accessors = (JArray?)json["accessors"] ?? [];
		JArray bufferViews = (JArray?)json["bufferViews"] ?? [];
		JArray materials = (JArray?)json["materials"] ?? [];
		JArray textures = (JArray?)json["textures"] ?? [];
		JArray images = (JArray?)json["images"] ?? [];
		JArray nodes = (JArray?)json["nodes"] ?? [];
		if (nodes.Count == 0)
		{
			// If a glTF chunk contains meshes but no nodes, treat each mesh as root.
			for (int meshIdx = 0; meshIdx < meshes.Count; meshIdx++)
			{
				ProcessMeshInstance(meshes, meshIdx, null, Matrix4x4.Identity, accessors, bufferViews, materials, textures, images, glbBinBytes, assetRoot, sourceBgl);
			}
			return;
		}

		int[] parentMap = BuildParentMap(nodes);
		Matrix4x4[] worldTransforms = BuildWorldTransforms(nodes, parentMap);
		for (int nodeIndex = 0; nodeIndex < nodes.Count; nodeIndex++)
		{
			JObject node = (JObject)nodes[nodeIndex]!;
			if (node["mesh"] == null)
			{
				continue;
			}
			int meshIndex = node["mesh"]!.Value<int>();
			if (meshIndex < 0 || meshIndex >= meshes.Count)
			{
				continue;
			}
			string? nodeName = node["name"]?.Value<string>();
			Matrix4x4 world = worldTransforms.Length > nodeIndex ? worldTransforms[nodeIndex] : Matrix4x4.Identity;
			ProcessMeshInstance(meshes, meshIndex, nodeName, world, accessors, bufferViews, materials, textures, images, glbBinBytes, assetRoot, sourceBgl);
		}
	}

	public void Merge(AcBuilder other, Matrix4x4 transform)
	{
		Dictionary<int, int> materialRemap = new();
		for (int i = 0; i < other._materials.Count; i++)
		{
			int targetIndex = EnsureMaterial(other._materials[i]);
			materialRemap[i] = targetIndex;
		}

		foreach (AcMeshObject mesh in other._objects)
		{
			AcMeshObject clone = mesh.Clone();
			clone.ApplyTransform(transform);
			if (!string.IsNullOrEmpty(clone.TextureSource))
			{
				string? remapped = RegisterTexture(clone.TextureSource, clone.TextureName);
				if (!string.IsNullOrEmpty(remapped))
				{
					clone.TextureName = remapped;
				}
			}
			clone.RemapMaterials(materialRemap);
			_objects.Add(clone);
		}

		foreach (var kvp in other._textureCopyTargets)
		{
			RegisterTexture(kvp.Key, kvp.Value);
		}
	}

	public void WriteToFile(string filePath)
	{
		string? directory = Path.GetDirectoryName(filePath);
		if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
		{
			_ = Directory.CreateDirectory(directory);
		}

		using StreamWriter writer = new(filePath, false, Encoding.ASCII)
		{
			NewLine = "\n"
		};
		writer.WriteLine("AC3Db");
		foreach (AcMaterial material in _materials)
		{
			material.Write(writer);
		}

		writer.WriteLine("OBJECT world");
		writer.WriteLine($"name \"{Sanitize(WorldName)}\"");
		writer.WriteLine($"kids {_objects.Count}");
		foreach (AcMeshObject obj in _objects)
		{
			obj.Write(writer);
		}

		writer.Flush();
		string targetDirectory = directory ?? Directory.GetCurrentDirectory();
		foreach (var texture in _textureCopyTargets)
		{
			string destination = Path.Combine(targetDirectory, texture.Value);
			try
			{
				if (string.Equals(texture.Key, destination, StringComparison.OrdinalIgnoreCase))
				{
					continue;
				}
				if (!File.Exists(destination))
				{
					File.Copy(texture.Key, destination, true);
				}
			}
			catch (IOException)
			{
				// Best effort texture copy; log if necessary upstream.
			}
		}
	}

	private void ProcessMeshInstance(
		JArray meshes,
		int meshIndex,
		string? nodeName,
		Matrix4x4 worldMatrix,
		JArray accessors,
		JArray bufferViews,
		JArray materials,
		JArray textures,
		JArray images,
		byte[] glbBinBytes,
		string assetRoot,
		string sourceBgl)
	{
		JObject meshJson = (JObject)meshes[meshIndex]!;
		string meshBaseName = meshJson["name"]?.Value<string>() ?? nodeName ?? $"mesh_{meshIndex}";
		JArray primitives = (JArray?)meshJson["primitives"] ?? [];
		int primitiveIndex = 0;
		foreach (JObject prim in primitives.Cast<JObject>())
		{
			PrimData primData = LoadPrimData(prim, accessors, bufferViews, glbBinBytes);
			if (primData.Positions.Length == 0)
			{
				continue;
			}

			string objectName = prim["name"]?.Value<string>() ?? $"{meshBaseName}_prim{primitiveIndex++}";
			MaterialBuildResult materialResult = BuildMaterialForPrimitive(prim, materials, textures, images, assetRoot, sourceBgl);
			int materialIndex = materialResult.MaterialIndex;
			string? textureName = materialResult.TextureSource != null ? RegisterTexture(materialResult.TextureSource) : null;
			AcMeshObject meshObject = new(objectName)
			{
				TextureName = textureName,
				TextureSource = materialResult.TextureSource
			};

			Vector3[] transformed = new Vector3[primData.Positions.Length];
			for (int i = 0; i < primData.Positions.Length; i++)
			{
				Vector3 world = Vector3.Transform(primData.Positions[i], worldMatrix);
				transformed[i] = new Vector3(world.X, world.Y, -world.Z);
			}
			Dictionary<VertexKey, int> vertexCache = new();

			int GetOrAddVertexIndex(int sourceIndex)
			{
				if (sourceIndex < 0 || sourceIndex >= transformed.Length)
				{
					return -1;
				}
				VertexKey key = VertexKey.FromVector(transformed[sourceIndex]);
				if (!vertexCache.TryGetValue(key, out int existing))
				{
					existing = meshObject.Vertices.Count;
					meshObject.Vertices.Add(transformed[sourceIndex]);
					vertexCache[key] = existing;
				}
				return existing;
			}

			int[] indices = primData.Indices.Length > 0 ? primData.Indices : Enumerable.Range(0, primData.Positions.Length).ToArray();
			int indicesPerTriangle = 3;
			int baseVertex = prim["extras"]?["ASOBO_primitive"]?["BaseVertexIndex"]?.Value<int>() ?? 0;
			int startIndex = prim["extras"]?["ASOBO_primitive"]?["StartIndex"]?.Value<int>() ?? 0;
			int primitiveCount = prim["extras"]?["ASOBO_primitive"]?["PrimitiveCount"]?.Value<int>() ?? 0;
			if (primitiveCount <= 0)
			{
				primitiveCount = (indices.Length - startIndex) / indicesPerTriangle;
			}
			int maxTriangles = Math.Min(primitiveCount, (indices.Length - startIndex) / indicesPerTriangle);
			Vector2[] texCoords = primData.TexCoords0;
			bool hasUv = texCoords.Length == primData.Positions.Length;

			for (int tri = 0; tri < maxTriangles; tri++)
			{
				int indexOffset = startIndex + (tri * indicesPerTriangle);
				int srcIdx0 = baseVertex + indices[indexOffset + 0];
				int srcIdx1 = baseVertex + indices[indexOffset + 1];
				int srcIdx2 = baseVertex + indices[indexOffset + 2];
				if (srcIdx0 < 0 || srcIdx1 < 0 || srcIdx2 < 0 ||
					srcIdx0 >= transformed.Length || srcIdx1 >= transformed.Length || srcIdx2 >= transformed.Length)
				{
					continue;
				}

				int idx0 = GetOrAddVertexIndex(srcIdx0);
				int idx1 = GetOrAddVertexIndex(srcIdx1);
				int idx2 = GetOrAddVertexIndex(srcIdx2);
				if (idx0 < 0 || idx1 < 0 || idx2 < 0)
				{
					continue;
				}

				AcSurface surface = new(materialIndex, materialResult.DoubleSided)
				{
					SmoothShaded = true
				};
				Vector2 uv0 = hasUv ? texCoords[srcIdx0] : Vector2.Zero;
				Vector2 uv1 = hasUv ? texCoords[srcIdx1] : Vector2.Zero;
				Vector2 uv2 = hasUv ? texCoords[srcIdx2] : Vector2.Zero;
				surface.AddVertex(idx0, uv0);
				surface.AddVertex(idx2, uv2);
				surface.AddVertex(idx1, uv1);
				meshObject.Surfaces.Add(surface);
			}

			if (meshObject.Surfaces.Count > 0)
			{
				_objects.Add(meshObject);
			}
		}
	}

	private MaterialBuildResult BuildMaterialForPrimitive(
		JObject primitive,
		JArray materials,
		JArray textures,
		JArray images,
		string assetRoot,
		string sourceBgl)
	{
		int gltfMaterialIndex = primitive["material"]?.Value<int>() ?? -1;
		if (gltfMaterialIndex < 0 || gltfMaterialIndex >= materials.Count)
		{
			return new MaterialBuildResult
			{
				MaterialIndex = 0,
				DoubleSided = false,
				TextureSource = null
			};
		}

		JObject mat = (JObject)materials[gltfMaterialIndex]!;
		JObject? pbr = (JObject?)mat["pbrMetallicRoughness"];
		Vector3 diffuse = new(1f, 1f, 1f);
		float alpha = 1f;
		if (pbr?["baseColorFactor"] is JArray baseColor && baseColor.Count >= 3)
		{
			diffuse = new Vector3(
				Math.Clamp(baseColor[0]!.Value<float>(), 0f, 1f),
				Math.Clamp(baseColor[1]!.Value<float>(), 0f, 1f),
				Math.Clamp(baseColor[2]!.Value<float>(), 0f, 1f));
			if (baseColor.Count >= 4)
			{
				alpha = Math.Clamp(baseColor[3]!.Value<float>(), 0f, 1f);
			}
		}
		float metallic = Math.Clamp(pbr?["metallicFactor"]?.Value<float>() ?? 0f, 0f, 1f);
		float roughness = Math.Clamp(pbr?["roughnessFactor"]?.Value<float>() ?? 1f, 0f, 1f);
		Vector3 emissive = new(0f, 0f, 0f);
		if (mat["emissiveFactor"] is JArray emissiveFactor && emissiveFactor.Count >= 3)
		{
			emissive = new Vector3(
				Math.Clamp(emissiveFactor[0]!.Value<float>(), 0f, 1f),
				Math.Clamp(emissiveFactor[1]!.Value<float>(), 0f, 1f),
				Math.Clamp(emissiveFactor[2]!.Value<float>(), 0f, 1f));
		}
		Vector3 ambient = diffuse * 0.2f;
		Vector3 specular = new(0.04f + metallic * 0.5f);
		int shininess = (int)MathF.Round((1f - roughness) * 128f);
		float transparency = Math.Clamp(1f - alpha, 0f, 1f);
		bool doubleSided = mat["doubleSided"]?.Value<bool>() ?? false;

		AcMaterial candidate = new(
			mat["name"]?.Value<string>() ?? $"mat_{gltfMaterialIndex}",
			diffuse,
			ambient,
			emissive,
			specular,
			shininess,
			transparency);
		int materialIndex = EnsureMaterial(candidate);

		string? textureSource = ResolveTexturePath(pbr?["baseColorTexture"], textures, images, assetRoot, sourceBgl);
		return new MaterialBuildResult
		{
			MaterialIndex = materialIndex,
			DoubleSided = doubleSided,
			TextureSource = textureSource
		};
	}

	private int EnsureMaterial(AcMaterial candidate)
	{
		if (_materialCache.TryGetValue(candidate.CacheKey, out int existing))
		{
			return existing;
		}
		int index = _materials.Count;
		_materials.Add(candidate);
		_materialCache[candidate.CacheKey] = index;
		return index;
	}

	private string? RegisterTexture(string? sourcePath, string? preferredName = null)
	{
		if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
		{
			return null;
		}
		if (_textureCopyTargets.TryGetValue(sourcePath, out string? existing))
		{
			return existing;
		}
		string candidateName = string.IsNullOrWhiteSpace(preferredName)
			? Path.GetFileName(sourcePath) ?? $"texture_{_textureCopyTargets.Count + 1}.dds"
			: preferredName!;
		string finalName = EnsureUniqueTextureName(candidateName);
		_textureCopyTargets[sourcePath] = finalName;
		_textureOutputNames.Add(finalName);
		return finalName;
	}

	private string EnsureUniqueTextureName(string baseName)
	{
		string sanitized = string.IsNullOrWhiteSpace(baseName) ? $"texture_{_textureCopyTargets.Count + 1}.dds" : baseName;
		string candidate = sanitized;
		int suffix = 1;
		while (_textureOutputNames.Contains(candidate))
		{
			string name = Path.GetFileNameWithoutExtension(sanitized);
			string ext = Path.GetExtension(sanitized);
			candidate = $"{name}_{suffix}{ext}";
			suffix++;
		}
		return candidate;
	}

	private static int[] BuildParentMap(JArray nodes)
	{
		int[] parents = Enumerable.Repeat(-1, nodes.Count).ToArray();
		for (int i = 0; i < nodes.Count; i++)
		{
			JObject node = (JObject)nodes[i]!;
			if (node["children"] is JArray children)
			{
				foreach (JToken child in children)
				{
					int childIndex = child.Value<int>();
					if (childIndex >= 0 && childIndex < parents.Length)
					{
						parents[childIndex] = i;
					}
				}
			}
		}
		return parents;
	}

	private static Matrix4x4[] BuildWorldTransforms(JArray nodes, int[] parentMap)
	{
		Matrix4x4[] transforms = new Matrix4x4[nodes.Count];
		for (int i = 0; i < nodes.Count; i++)
		{
			Matrix4x4 world = Matrix4x4.Identity;
			int? current = i;
			while (current != null && current >= 0)
			{
				JObject node = (JObject)nodes[current.Value]!;
				Matrix4x4 local = ParseLocalTransform(node);
				world = local * world;
				int parentIndex = parentMap[current.Value];
				current = parentIndex >= 0 ? parentIndex : null;
			}
			transforms[i] = world;
		}
		return transforms;
	}

	private static Matrix4x4 ParseLocalTransform(JObject node)
	{
		if (node["matrix"] is JArray matrix && matrix.Count == 16)
		{
			return new Matrix4x4(
				matrix[0]!.Value<float>(), matrix[1]!.Value<float>(), matrix[2]!.Value<float>(), matrix[3]!.Value<float>(),
				matrix[4]!.Value<float>(), matrix[5]!.Value<float>(), matrix[6]!.Value<float>(), matrix[7]!.Value<float>(),
				matrix[8]!.Value<float>(), matrix[9]!.Value<float>(), matrix[10]!.Value<float>(), matrix[11]!.Value<float>(),
				matrix[12]!.Value<float>(), matrix[13]!.Value<float>(), matrix[14]!.Value<float>(), matrix[15]!.Value<float>());
		}

		Vector3 translation = node["translation"] is JArray t && t.Count == 3
			? new Vector3(t[0]!.Value<float>(), t[1]!.Value<float>(), t[2]!.Value<float>())
			: Vector3.Zero;
		Quaternion rotation = node["rotation"] is JArray r && r.Count == 4
			? new Quaternion(r[0]!.Value<float>(), r[1]!.Value<float>(), r[2]!.Value<float>(), r[3]!.Value<float>())
			: Quaternion.Identity;
		Vector3 scale = node["scale"] is JArray s && s.Count == 3
			? new Vector3(s[0]!.Value<float>(), s[1]!.Value<float>(), s[2]!.Value<float>())
			: Vector3.One;
		return Matrix4x4.CreateScale(scale) * Matrix4x4.CreateFromQuaternion(Quaternion.Normalize(rotation)) * Matrix4x4.CreateTranslation(translation);
	}

	private static PrimData LoadPrimData(JObject primitive, JArray accessors, JArray bufferViews, byte[] glbBinBytes)
	{
		PrimData data = new();
		if (primitive["attributes"] is not JObject attributes)
		{
			return data;
		}

		if (attributes["POSITION"] != null)
		{
			int accessorIndex = attributes["POSITION"]!.Value<int>();
			if (accessorIndex >= 0 && accessorIndex < accessors.Count)
			{
				data.Positions = LoadPositionData((JObject)accessors[accessorIndex]!, bufferViews, glbBinBytes);
			}
		}
		if (primitive["indices"] != null)
		{
			int indicesAccessor = primitive["indices"]!.Value<int>();
			if (indicesAccessor >= 0 && indicesAccessor < accessors.Count)
			{
				data.Indices = LoadIndexData((JObject)accessors[indicesAccessor]!, bufferViews, glbBinBytes);
			}
		}
		if (attributes["TEXCOORD_0"] != null)
		{
			int accessorIndex = attributes["TEXCOORD_0"]!.Value<int>();
			if (accessorIndex >= 0 && accessorIndex < accessors.Count)
			{
				data.TexCoords0 = LoadTexCoordData((JObject)accessors[accessorIndex]!, bufferViews, glbBinBytes);
			}
		}
		return data;
	}

	private static Vector3[] LoadPositionData(JObject accessor, JArray bufferViews, byte[] bin)
	{
		int count = accessor["count"]!.Value<int>();
		int bufferViewIndex = accessor["bufferView"]!.Value<int>();
		if (bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count)
		{
			return Array.Empty<Vector3>();
		}
		JObject bufferView = (JObject)bufferViews[bufferViewIndex]!;
		int accessorByteOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
		int componentType = accessor["componentType"]!.Value<int>();
		int componentSize = ComponentSize(componentType);
		int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * 3);
		Vector3[] positions = new Vector3[count];
		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewOffset + accessorByteOffset + (i * stride);
			positions[i] = new Vector3(
				BitConverter.ToSingle(bin, offset + (0 * componentSize)),
				BitConverter.ToSingle(bin, offset + (1 * componentSize)),
				BitConverter.ToSingle(bin, offset + (2 * componentSize)));
		}
		return positions;
	}

	private static int[] LoadIndexData(JObject accessor, JArray bufferViews, byte[] bin)
	{
		int count = accessor["count"]!.Value<int>();
		int bufferViewIndex = accessor["bufferView"]!.Value<int>();
		if (bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count)
		{
			return Array.Empty<int>();
		}
		JObject bufferView = (JObject)bufferViews[bufferViewIndex]!;
		int accessorByteOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
		int componentType = accessor["componentType"]!.Value<int>();
		int componentSize = ComponentSize(componentType);
		int stride = componentSize;
		int[] indices = new int[count];
		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewOffset + accessorByteOffset + (i * stride);
			indices[i] = componentType switch
			{
				5121 => bin[offset], // UNSIGNED_BYTE
				5123 => BitConverter.ToUInt16(bin, offset), // UNSIGNED_SHORT
				5125 => (int)BitConverter.ToUInt32(bin, offset), // UNSIGNED_INT
				_ => 0
			};
		}
		return indices;
	}

	private static Vector2[] LoadTexCoordData(JObject accessor, JArray bufferViews, byte[] bin)
	{
		int count = accessor["count"]!.Value<int>();
		int bufferViewIndex = accessor["bufferView"]!.Value<int>();
		if (bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count)
		{
			return Array.Empty<Vector2>();
		}
		JObject bufferView = (JObject)bufferViews[bufferViewIndex]!;
		int accessorByteOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
		int bufferViewOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
		int componentType = accessor["componentType"]!.Value<int>();
		int componentSize = ComponentSize(componentType);
		int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * 2);
		Vector2[] texCoords = new Vector2[count];
		for (int i = 0; i < count; i++)
		{
			int offset = bufferViewOffset + accessorByteOffset + (i * stride);
			switch (componentType)
			{
				case 5126: // FLOAT
					{
						float u = BitConverter.ToSingle(bin, offset);
						float v = BitConverter.ToSingle(bin, offset + componentSize);
						texCoords[i] = new Vector2(u, 1f - v);
						break;
					}
				case 5122: // SHORT -> Half precision
					{
						Half u = BitConverter.ToHalf(bin, offset);
						Half v = BitConverter.ToHalf(bin, offset + componentSize);
						texCoords[i] = new Vector2((float)u, 1f - (float)v);
						break;
					}
				case 5123: // UNSIGNED_SHORT normalized
					{
						ushort u = BitConverter.ToUInt16(bin, offset);
						ushort v = BitConverter.ToUInt16(bin, offset + componentSize);
						texCoords[i] = new Vector2(u / 65535f, 1f - (v / 65535f));
						break;
					}
				case 5121: // UNSIGNED_BYTE normalized
					{
						byte u = bin[offset];
						byte v = bin[offset + 1];
						texCoords[i] = new Vector2(u / 255f, 1f - (v / 255f));
						break;
					}
				default:
					texCoords[i] = Vector2.Zero;
					break;
			}
		}
		return texCoords;
	}

	private static int ComponentSize(int componentType)
	{
		return componentType switch
		{
			5120 => 1,
			5121 => 1,
			5122 => 2,
			5123 => 2,
			5125 => 4,
			5126 => 4,
			_ => 4
		};
	}

	private static string? ResolveTexturePath(JToken? textureInfo, JArray textures, JArray images, string assetRoot, string sourceBgl)
	{
		if (textureInfo == null)
		{
			return null;
		}
		int textureIndex = textureInfo["index"]?.Value<int>() ?? -1;
		if (textureIndex < 0 || textureIndex >= textures.Count)
		{
			return null;
		}
		JObject texture = (JObject)textures[textureIndex]!;
		int imageIndex = texture["source"]?.Value<int>()
			?? texture["extensions"]?["MSFT_texture_dds"]?["source"]?.Value<int>()
			?? -1;
		if (imageIndex < 0 || imageIndex >= images.Count)
		{
			return null;
		}
		JObject image = (JObject)images[imageIndex]!;
		string? uri = image["uri"]?.Value<string>();
		if (string.IsNullOrWhiteSpace(uri))
		{
			return null;
		}
		string fileName = Path.GetFileName(uri);
		if (string.IsNullOrWhiteSpace(fileName))
		{
			return null;
		}
		if (!string.IsNullOrEmpty(assetRoot) && Directory.Exists(assetRoot))
		{
			string[] matches = Directory.GetFiles(assetRoot, fileName, new EnumerationOptions
			{
				MatchCasing = MatchCasing.CaseInsensitive,
				RecurseSubdirectories = true,
				ReturnSpecialDirectories = false
			});
			if (matches.Length > 0)
			{
				return matches.OrderByDescending(path => CommonPrefixLength(path, sourceBgl)).First();
			}
		}
		string candidate = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceBgl) ?? string.Empty, uri));
		return File.Exists(candidate) ? candidate : null;
	}

	private static int CommonPrefixLength(string lhs, string rhs)
	{
		int max = Math.Min(lhs.Length, rhs.Length);
		int count = 0;
		for (int i = 0; i < max; i++)
		{
			if (char.ToLowerInvariant(lhs[i]) == char.ToLowerInvariant(rhs[i]))
			{
				count++;
			}
			else
			{
				break;
			}
		}
		return count;
	}

	private static string Sanitize(string? value)
	{
		if (string.IsNullOrEmpty(value))
		{
			return "Unnamed";
		}
		return value.Replace('"', '_');
	}

	private static string FormatFloat(float value)
	{
		return value.ToString("0.######", Culture);
	}

	private sealed record MaterialBuildResult
	{
		public int MaterialIndex { get; init; }
		public bool DoubleSided { get; init; }
		public string? TextureSource { get; init; }
	}

	private sealed class PrimData
	{
		public Vector3[] Positions { get; set; } = Array.Empty<Vector3>();
		public int[] Indices { get; set; } = Array.Empty<int>();
		public Vector2[] TexCoords0 { get; set; } = Array.Empty<Vector2>();
	}

	public sealed class AcMeshObject
	{
		public string Name { get; }
		public List<Vector3> Vertices { get; } = [];
		public List<AcSurface> Surfaces { get; } = [];
		public string? TextureName { get; set; }
		public string? TextureSource { get; set; }
		public Vector2 TextureRepeat { get; set; } = new(1f, 1f);
		public float Crease { get; set; } = 30f;

		public AcMeshObject(string name)
		{
			Name = string.IsNullOrWhiteSpace(name) ? "poly" : name;
		}

		public void ApplyTransform(Matrix4x4 transform)
		{
			for (int i = 0; i < Vertices.Count; i++)
			{
				Vector3 world = Vector3.Transform(Vertices[i], transform);
				Vertices[i] = new Vector3(world.X, world.Y, world.Z);
			}
		}

		public void RemapMaterials(Dictionary<int, int> remap)
		{
			foreach (AcSurface surface in Surfaces)
			{
				if (remap.TryGetValue(surface.MaterialIndex, out int mapped))
				{
					surface.MaterialIndex = mapped;
				}
			}
		}

		public AcMeshObject Clone()
		{
			AcMeshObject clone = new(Name)
			{
				TextureName = TextureName,
				TextureSource = TextureSource,
				TextureRepeat = TextureRepeat,
				Crease = Crease
			};
			clone.Vertices.AddRange(Vertices);
			foreach (AcSurface surface in Surfaces)
			{
				clone.Surfaces.Add(surface.Clone());
			}
			return clone;
		}

		public void Write(StreamWriter writer)
		{
			writer.WriteLine("OBJECT poly");
			writer.WriteLine($"name \"{Sanitize(Name)}\"");
			writer.WriteLine($"crease {FormatFloat(Crease)}");
			if (!string.IsNullOrEmpty(TextureName))
			{
				writer.WriteLine($"texture \"{TextureName}\"");
				if (Math.Abs(TextureRepeat.X - 1f) > 0.0001f || Math.Abs(TextureRepeat.Y - 1f) > 0.0001f)
				{
					writer.WriteLine($"texrep {FormatFloat(TextureRepeat.X)} {FormatFloat(TextureRepeat.Y)}");
				}
			}
			writer.WriteLine($"numvert {Vertices.Count}");
			foreach (Vector3 vertex in Vertices)
			{
				writer.WriteLine($"{FormatFloat(-vertex.X)} {FormatFloat(vertex.Y)} {FormatFloat(vertex.Z)}");
			}
			writer.WriteLine($"numsurf {Surfaces.Count}");
			foreach (AcSurface surface in Surfaces)
			{
				surface.Write(writer);
			}
			writer.WriteLine("kids 0");
		}
	}

	public sealed class AcSurface
	{
		private readonly List<int> _vertexIndices = [];
		private readonly List<Vector2> _uvs = [];

		public int MaterialIndex { get; set; }
		public bool SmoothShaded { get; set; }
		public bool DoubleSided { get; }

		public AcSurface(int materialIndex, bool doubleSided)
		{
			MaterialIndex = materialIndex;
			DoubleSided = doubleSided;
		}

		public void AddVertex(int vertexIndex, Vector2 uv)
		{
			_vertexIndices.Add(vertexIndex);
			_uvs.Add(new Vector2(uv.X, 1 - uv.Y));
		}

		public void Write(StreamWriter writer)
		{
			int flags = 0x00;
			if (SmoothShaded)
			{
				flags |= 0x10;
			}
			if (DoubleSided)
			{
				flags |= 0x20;
			}
			writer.WriteLine($"SURF 0x{flags:X}");
			writer.WriteLine($"mat {MaterialIndex}");
			writer.WriteLine($"refs {_vertexIndices.Count}");
			for (int i = 0; i < _vertexIndices.Count; i++)
			{
				writer.WriteLine($"{_vertexIndices[i]} {FormatFloat(_uvs[i].X)} {FormatFloat(_uvs[i].Y)}");
			}
		}

		public AcSurface Clone()
		{
			AcSurface clone = new(MaterialIndex, DoubleSided)
			{
				SmoothShaded = SmoothShaded
			};
			clone._vertexIndices.AddRange(_vertexIndices);
			clone._uvs.AddRange(_uvs);
			return clone;
		}
	}

	private readonly struct VertexKey : IEquatable<VertexKey>
	{
		private readonly int _x;
		private readonly int _y;
		private readonly int _z;

		private VertexKey(int x, int y, int z)
		{
			_x = x;
			_y = y;
			_z = z;
		}

		public static VertexKey FromVector(Vector3 position)
		{
			return new VertexKey(
				Quantize(position.X),
				Quantize(position.Y),
				Quantize(position.Z));
		}

		public bool Equals(VertexKey other)
		{
			return _x == other._x && _y == other._y && _z == other._z;
		}

		public override bool Equals(object? obj)
		{
			return obj is VertexKey other && Equals(other);
		}

		public override int GetHashCode()
		{
			return HashCode.Combine(_x, _y, _z);
		}

		private static int Quantize(float value)
		{
			return (int)MathF.Round(value * VertexQuantizationScale);
		}
	}

	public sealed class AcMaterial
	{
		public string Name { get; }
		public Vector3 Diffuse { get; }
		public Vector3 Ambient { get; }
		public Vector3 Emissive { get; }
		public Vector3 Specular { get; }
		public int Shininess { get; }
		public float Transparency { get; }
		public string CacheKey { get; }

		public AcMaterial(string name, Vector3 diffuse, Vector3 ambient, Vector3 emissive, Vector3 specular, int shininess, float transparency)
		{
			Name = Sanitize(name);
			Diffuse = diffuse;
			Ambient = ambient;
			Emissive = emissive;
			Specular = specular;
			Shininess = Math.Clamp(shininess, 0, 128);
			Transparency = Math.Clamp(transparency, 0f, 1f);
			CacheKey = $"{Diffuse.X:F3}|{Diffuse.Y:F3}|{Diffuse.Z:F3}|{Ambient.X:F3}|{Ambient.Y:F3}|{Ambient.Z:F3}|{Emissive.X:F3}|{Emissive.Y:F3}|{Emissive.Z:F3}|{Specular.X:F3}|{Specular.Y:F3}|{Specular.Z:F3}|{Shininess}|{Transparency:F3}";
		}

		public static AcMaterial CreateDefault()
		{
			return new AcMaterial("DefaultWhite", new Vector3(1f, 1f, 1f), new Vector3(0.2f, 0.2f, 0.2f), Vector3.Zero, new Vector3(0.5f, 0.5f, 0.5f), 64, 0f);
		}

		public void Write(StreamWriter writer)
		{
			writer.WriteLine(
				$"MATERIAL \"{Name}\" rgb {FormatFloat(Diffuse.X)} {FormatFloat(Diffuse.Y)} {FormatFloat(Diffuse.Z)} " +
				$" amb {FormatFloat(Ambient.X)} {FormatFloat(Ambient.Y)} {FormatFloat(Ambient.Z)} " +
				$" emis {FormatFloat(Emissive.X)} {FormatFloat(Emissive.Y)} {FormatFloat(Emissive.Z)} " +
				$" spec {FormatFloat(Specular.X)} {FormatFloat(Specular.Y)} {FormatFloat(Specular.Z)} " +
				$" shi {Shininess} trans {FormatFloat(Transparency)}");
		}
	}
}