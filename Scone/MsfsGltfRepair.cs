using System.Numerics;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SharpGLTF.Schema2;
using SharpGLTF.Validation;

namespace Scone;

internal sealed record MsfsGltfRepairResult(string OutputPath, int RewrittenTexCoordAccessorCount, int NormalizedNodeScaleCount);

internal static class MsfsGltfRepair
{
	public static MsfsGltfRepairResult ExportFixedGltf(string sourceGltfPath, string destinationGltfPath)
	{
		if (!File.Exists(sourceGltfPath))
		{
			throw new FileNotFoundException($"glTF file not found: {sourceGltfPath}", sourceGltfPath);
		}
		if (!string.Equals(Path.GetExtension(sourceGltfPath), ".gltf", StringComparison.OrdinalIgnoreCase))
		{
			throw new NotSupportedException($"Only .gltf files are supported by the targeted repair path: {sourceGltfPath}");
		}

		string sourceDirectory = Path.GetDirectoryName(sourceGltfPath) ?? Directory.GetCurrentDirectory();
		string destinationDirectory = Path.GetDirectoryName(destinationGltfPath) ?? Directory.GetCurrentDirectory();
		Directory.CreateDirectory(destinationDirectory);

		JObject gltf = JObject.Parse(File.ReadAllText(sourceGltfPath));
		JArray buffers = (JArray?)gltf["buffers"] ?? throw new InvalidDataException($"glTF is missing buffers: {sourceGltfPath}");
		JArray bufferViews = (JArray?)gltf["bufferViews"] ?? throw new InvalidDataException($"glTF is missing bufferViews: {sourceGltfPath}");
		JArray accessors = (JArray?)gltf["accessors"] ?? throw new InvalidDataException($"glTF is missing accessors: {sourceGltfPath}");

		Dictionary<int, byte[]> sourceBufferData = LoadSourceBuffers(buffers, sourceDirectory);
		Dictionary<string, string> copiedResources = [];

		CopyAndRelinkExternalResources(buffers, "uri", sourceDirectory, destinationDirectory, copiedResources);
		CopyAndRelinkExternalResources((JArray?)gltf["images"], "uri", sourceDirectory, destinationDirectory, copiedResources);

		int rewrittenTexCoordAccessorCount = RewriteTexCoordAccessors(
			gltf,
			accessors,
			bufferViews,
			buffers,
			sourceBufferData,
			destinationDirectory,
			Path.GetFileNameWithoutExtension(destinationGltfPath));
		RewritePackedDirectionAccessors(
			gltf,
			accessors,
			bufferViews,
			buffers,
			sourceBufferData,
			destinationDirectory,
			Path.GetFileNameWithoutExtension(destinationGltfPath));
		RewriteOutOfRangeJointAccessors(
			gltf,
			accessors,
			bufferViews,
			buffers,
			sourceBufferData,
			destinationDirectory,
			Path.GetFileNameWithoutExtension(destinationGltfPath));
		RewriteSkinWeightAccessors(
			gltf,
			accessors,
			bufferViews,
			buffers,
			sourceBufferData,
			destinationDirectory,
			Path.GetFileNameWithoutExtension(destinationGltfPath));

		int normalizedNodeScaleCount = NormalizeOptimizedNodeScales((JArray?)gltf["nodes"]);
		NormalizeKnownAttributeAccessors(gltf, accessors);
		EnsureDeclaredExtensions(gltf, accessors);

		File.WriteAllText(destinationGltfPath, gltf.ToString(Formatting.Indented));
		ValidateRepairedGltf(destinationGltfPath);

		return new MsfsGltfRepairResult(destinationGltfPath, rewrittenTexCoordAccessorCount, normalizedNodeScaleCount);
	}

	private static Dictionary<int, byte[]> LoadSourceBuffers(JArray buffers, string sourceDirectory)
	{
		Dictionary<int, byte[]> bufferData = [];

		for (int i = 0; i < buffers.Count; i++)
		{
			if (buffers[i] is not JObject buffer)
			{
				throw new InvalidDataException($"Buffer {i} is not an object.");
			}

			string? uri = buffer["uri"]?.Value<string>();
			if (string.IsNullOrWhiteSpace(uri))
			{
				throw new InvalidDataException($"Buffer {i} in the glTF does not define a uri.");
			}

			bufferData[i] = ReadBufferBytes(uri, sourceDirectory);
		}

		return bufferData;
	}

	private static void CopyAndRelinkExternalResources(JArray? array, string propertyName, string sourceDirectory, string destinationDirectory, Dictionary<string, string> copiedResources)
	{
		if (array == null)
		{
			return;
		}

		foreach (JObject item in array.OfType<JObject>())
		{
			string? uri = item[propertyName]?.Value<string>();
			if (string.IsNullOrWhiteSpace(uri) || uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
			{
				continue;
			}

			string sourcePath = ResolveResourcePath(sourceDirectory, uri);
			if (!File.Exists(sourcePath))
			{
				throw new FileNotFoundException($"Referenced glTF resource is missing: {sourcePath}", sourcePath);
			}

			string targetName = GetOrCreateCopiedResourceName(sourcePath, copiedResources);
			File.Copy(sourcePath, Path.Combine(destinationDirectory, targetName), true);
			item[propertyName] = targetName;
		}
	}

	private static string GetOrCreateCopiedResourceName(string sourcePath, Dictionary<string, string> copiedResources)
	{
		if (copiedResources.TryGetValue(sourcePath, out string? existingName))
		{
			return existingName;
		}

		string baseName = Path.GetFileName(sourcePath);
		string name = Path.GetFileNameWithoutExtension(baseName);
		string extension = Path.GetExtension(baseName);
		string candidate = baseName;
		int suffix = 1;

		while (copiedResources.Values.Any(value => string.Equals(value, candidate, StringComparison.OrdinalIgnoreCase)))
		{
			candidate = $"{name}_{suffix}{extension}";
			suffix++;
		}

		copiedResources[sourcePath] = candidate;
		return candidate;
	}

	private static int RewriteTexCoordAccessors(JObject gltf, JArray accessors, JArray bufferViews, JArray buffers, IReadOnlyDictionary<int, byte[]> sourceBufferData, string destinationDirectory, string destinationStem)
	{
		List<int> texCoordAccessorIndices = [.. GetTexCoordAccessorIndices(gltf).OrderBy(index => index)];
		if (texCoordAccessorIndices.Count == 0)
		{
			return 0;
		}

		using MemoryStream floatTexCoordBuffer = new();
		int rewrittenCount = 0;
		int newBufferIndex = -1;

		foreach (int accessorIndex in texCoordAccessorIndices)
		{
			if (accessors[accessorIndex] is not JObject accessor)
			{
				throw new InvalidDataException($"Accessor {accessorIndex} is not an object.");
			}

			int componentType = accessor["componentType"]?.Value<int>() ?? 0;
			if (componentType != 5122)
			{
				continue;
			}

			if (!string.Equals(accessor["type"]?.Value<string>(), "VEC2", StringComparison.Ordinal))
			{
				throw new InvalidDataException($"Accessor {accessorIndex} uses TEXCOORD semantics but is not a VEC2 accessor.");
			}
			if (accessor["sparse"] != null)
			{
				throw new NotSupportedException($"Sparse TEXCOORD accessors are not supported for targeted repair: accessor {accessorIndex}.");
			}

			int bufferViewIndex = accessor["bufferView"]?.Value<int>() ?? -1;
			if (bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count || bufferViews[bufferViewIndex] is not JObject bufferView)
			{
				throw new InvalidDataException($"Accessor {accessorIndex} references an invalid bufferView.");
			}

			int sourceBufferIndex = bufferView["buffer"]?.Value<int>() ?? -1;
			if (!sourceBufferData.TryGetValue(sourceBufferIndex, out byte[]? bufferBytes))
			{
				throw new InvalidDataException($"bufferView {bufferViewIndex} references an unknown buffer index {sourceBufferIndex}.");
			}

			int count = accessor["count"]?.Value<int>() ?? 0;
			int accessorByteOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
			int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
			int stride = bufferView["byteStride"]?.Value<int>() ?? sizeof(ushort) * 2;

			if (newBufferIndex < 0)
			{
				string extraBufferName = $"{destinationStem}.texcoord-fixes.bin";
				buffers.Add(new JObject
				{
					["byteLength"] = 0,
					["uri"] = extraBufferName
				});
				newBufferIndex = buffers.Count - 1;
			}

			AlignStream(floatTexCoordBuffer, sizeof(float));
			int newBufferViewOffset = checked((int)floatTexCoordBuffer.Position);
			byte[] convertedBytes = new byte[count * sizeof(float) * 2];

			for (int i = 0; i < count; i++)
			{
				int sourceOffset = bufferViewByteOffset + accessorByteOffset + (i * stride);
				EnsureReadableRange(bufferBytes, sourceOffset, sizeof(ushort) * 2, accessorIndex);

				Half u = BitConverter.ToHalf(bufferBytes, sourceOffset);
				Half v = BitConverter.ToHalf(bufferBytes, sourceOffset + sizeof(ushort));

				BitConverter.GetBytes((float)u).CopyTo(convertedBytes, i * sizeof(float) * 2);
				BitConverter.GetBytes((float)v).CopyTo(convertedBytes, (i * sizeof(float) * 2) + sizeof(float));
			}

			floatTexCoordBuffer.Write(convertedBytes, 0, convertedBytes.Length);

			JObject newBufferView = new()
			{
				["buffer"] = newBufferIndex,
				["byteOffset"] = newBufferViewOffset,
				["byteLength"] = convertedBytes.Length
			};

			if (bufferView["target"] != null)
			{
				newBufferView["target"] = bufferView["target"]!.DeepClone();
			}
			if (accessor["name"] != null)
			{
				newBufferView["name"] = $"{accessor["name"]!.Value<string>()}_FloatBufferView";
			}

			bufferViews.Add(newBufferView);
			accessor["bufferView"] = bufferViews.Count - 1;
			accessor["componentType"] = 5126;
			accessor.Property("byteOffset")?.Remove();
			rewrittenCount++;
		}

		if (rewrittenCount > 0 && newBufferIndex >= 0)
		{
			byte[] bytes = floatTexCoordBuffer.ToArray();
			JObject newBuffer = (JObject)buffers[newBufferIndex]!;
			newBuffer["byteLength"] = bytes.Length;
			File.WriteAllBytes(Path.Combine(destinationDirectory, newBuffer["uri"]!.Value<string>()!), bytes);
		}

		return rewrittenCount;
	}

	private static void RewritePackedDirectionAccessors(JObject gltf, JArray accessors, JArray bufferViews, JArray buffers, IReadOnlyDictionary<int, byte[]> sourceBufferData, string destinationDirectory, string destinationStem)
	{
		Dictionary<int, string> accessorSemantics = GetMeshAccessorSemantics(gltf, new HashSet<string>(StringComparer.Ordinal) { "NORMAL", "TANGENT" });
		if (accessorSemantics.Count == 0)
		{
			return;
		}

		using MemoryStream directionBuffer = new();
		int newBufferIndex = -1;

		foreach ((int accessorIndex, string semantic) in accessorSemantics.OrderBy(pair => pair.Key))
		{
			if (accessors[accessorIndex] is not JObject accessor)
			{
				throw new InvalidDataException($"Accessor {accessorIndex} is not an object.");
			}

			int bufferViewIndex = accessor["bufferView"]?.Value<int>() ?? -1;
			if (bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count || bufferViews[bufferViewIndex] is not JObject bufferView)
			{
				throw new InvalidDataException($"Accessor {accessorIndex} references an invalid bufferView.");
			}

			int sourceBufferIndex = bufferView["buffer"]?.Value<int>() ?? -1;
			if (!sourceBufferData.TryGetValue(sourceBufferIndex, out byte[]? bufferBytes))
			{
				throw new InvalidDataException($"bufferView {bufferViewIndex} references an unknown buffer index {sourceBufferIndex}.");
			}

			int componentType = accessor["componentType"]?.Value<int>() ?? 0;
			string type = accessor["type"]?.Value<string>() ?? string.Empty;
			if (semantic == "NORMAL" && componentType == 5126 && string.Equals(type, "VEC3", StringComparison.Ordinal))
			{
				continue;
			}
			if (semantic == "TANGENT" && componentType == 5126 && string.Equals(type, "VEC4", StringComparison.Ordinal))
			{
				continue;
			}

			if (newBufferIndex < 0)
			{
				string extraBufferName = $"{destinationStem}.direction-fixes.bin";
				buffers.Add(new JObject
				{
					["byteLength"] = 0,
					["uri"] = extraBufferName
				});
				newBufferIndex = buffers.Count - 1;
			}

			int count = accessor["count"]?.Value<int>() ?? 0;
			int accessorByteOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
			int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
			int componentSize = ComponentSize(componentType);
			int sourceComponents = type switch
			{
				"VEC3" => 3,
				"VEC4" => 4,
				_ => throw new InvalidDataException($"Accessor {accessorIndex} uses unsupported type {type} for {semantic}.")
			};
			int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * sourceComponents);

			AlignStream(directionBuffer, sizeof(float));
			int newBufferViewOffset = checked((int)directionBuffer.Position);
			byte[] convertedBytes = semantic == "NORMAL"
				? new byte[count * sizeof(float) * 3]
				: new byte[count * sizeof(float) * 4];

			for (int i = 0; i < count; i++)
			{
				int sourceOffset = bufferViewByteOffset + accessorByteOffset + (i * stride);
				EnsureReadableRange(bufferBytes, sourceOffset, componentSize * sourceComponents, accessorIndex);

				float x = ReadSignedNormalizedComponent(bufferBytes, sourceOffset, componentType);
				float y = ReadSignedNormalizedComponent(bufferBytes, sourceOffset + componentSize, componentType);
				float z = ReadSignedNormalizedComponent(bufferBytes, sourceOffset + (componentSize * 2), componentType);
				Vector3 direction = new(x, y, z);
				if (direction != Vector3.Zero)
				{
					direction = Vector3.Normalize(direction);
				}

				int destinationOffset = semantic == "NORMAL" ? i * sizeof(float) * 3 : i * sizeof(float) * 4;
				BitConverter.GetBytes(direction.X).CopyTo(convertedBytes, destinationOffset);
				BitConverter.GetBytes(direction.Y).CopyTo(convertedBytes, destinationOffset + sizeof(float));
				BitConverter.GetBytes(direction.Z).CopyTo(convertedBytes, destinationOffset + (sizeof(float) * 2));

				if (semantic == "TANGENT")
				{
					float handedness = ReadSignedNormalizedComponent(bufferBytes, sourceOffset + (componentSize * 3), componentType) >= 0f ? 1f : -1f;
					BitConverter.GetBytes(handedness).CopyTo(convertedBytes, destinationOffset + (sizeof(float) * 3));
				}
			}
			directionBuffer.Write(convertedBytes, 0, convertedBytes.Length);

			JObject newBufferView = new()
			{
				["buffer"] = newBufferIndex,
				["byteOffset"] = newBufferViewOffset,
				["byteLength"] = convertedBytes.Length
			};

			if (bufferView["target"] != null)
			{
				newBufferView["target"] = bufferView["target"]!.DeepClone();
			}
			if (accessor["name"] != null)
			{
				newBufferView["name"] = $"{accessor["name"]!.Value<string>()}_{semantic}_FloatBufferView";
			}

			bufferViews.Add(newBufferView);
			accessor["bufferView"] = bufferViews.Count - 1;
			accessor["componentType"] = 5126;
			accessor["type"] = semantic == "NORMAL" ? "VEC3" : "VEC4";
			accessor.Property("byteOffset")?.Remove();
			accessor.Property("normalized")?.Remove();
		}

		if (newBufferIndex >= 0)
		{
			byte[] bytes = directionBuffer.ToArray();
			JObject newBuffer = (JObject)buffers[newBufferIndex]!;
			newBuffer["byteLength"] = bytes.Length;
			File.WriteAllBytes(Path.Combine(destinationDirectory, newBuffer["uri"]!.Value<string>()!), bytes);
		}
	}

	private static void RewriteOutOfRangeJointAccessors(JObject gltf, JArray accessors, JArray bufferViews, JArray buffers, IReadOnlyDictionary<int, byte[]> sourceBufferData, string destinationDirectory, string destinationStem)
	{
		Dictionary<int, int> meshSkinMap = GetMeshSkinMap(gltf);
		if (meshSkinMap.Count == 0 || gltf["skins"] is not JArray skins)
		{
			return;
		}

		using MemoryStream jointBuffer = new();
		int newBufferIndex = -1;
		JArray meshes = (JArray?)gltf["meshes"] ?? [];

		foreach ((int meshIndex, int skinIndex) in meshSkinMap.OrderBy(pair => pair.Key))
		{
			if (meshIndex < 0 || meshIndex >= meshes.Count || meshes[meshIndex] is not JObject mesh)
			{
				continue;
			}
			if (skinIndex < 0 || skinIndex >= skins.Count || skins[skinIndex] is not JObject skin || skin["joints"] is not JArray joints)
			{
				continue;
			}

			int jointCount = joints.Count;
			foreach (JObject primitive in mesh["primitives"]?.OfType<JObject>() ?? [])
			{
				if (primitive["attributes"] is not JObject attributes || attributes["JOINTS_0"]?.Type != JTokenType.Integer)
				{
					continue;
				}

				int accessorIndex = attributes["JOINTS_0"]!.Value<int>();
				if (accessorIndex < 0 || accessorIndex >= accessors.Count || accessors[accessorIndex] is not JObject accessor)
				{
					throw new InvalidDataException($"JOINTS_0 references an invalid accessor index {accessorIndex}.");
				}

				int bufferViewIndex = accessor["bufferView"]?.Value<int>() ?? -1;
				if (bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count || bufferViews[bufferViewIndex] is not JObject bufferView)
				{
					throw new InvalidDataException($"Accessor {accessorIndex} references an invalid bufferView.");
				}

				int componentType = accessor["componentType"]?.Value<int>() ?? 0;
				if (componentType != 5121 && componentType != 5123)
				{
					continue;
				}

				int sourceBufferIndex = bufferView["buffer"]?.Value<int>() ?? -1;
				if (!sourceBufferData.TryGetValue(sourceBufferIndex, out byte[]? bufferBytes))
				{
					throw new InvalidDataException($"bufferView {bufferViewIndex} references an unknown buffer index {sourceBufferIndex}.");
				}

				int count = accessor["count"]?.Value<int>() ?? 0;
				int accessorByteOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
				int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
				int componentSize = ComponentSize(componentType);
				int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * 4);
				bool requiresRewrite = false;

				for (int i = 0; i < count && !requiresRewrite; i++)
				{
					int sourceOffset = bufferViewByteOffset + accessorByteOffset + (i * stride);
					EnsureReadableRange(bufferBytes, sourceOffset, componentSize * 4, accessorIndex);

					for (int componentIndex = 0; componentIndex < 4; componentIndex++)
					{
						int value = ReadUnsignedJointComponent(bufferBytes, sourceOffset + (componentIndex * componentSize), componentType);
						if (value >= jointCount)
						{
							requiresRewrite = true;
							break;
						}
					}
				}

				if (!requiresRewrite)
				{
					continue;
				}

				if (newBufferIndex < 0)
				{
					string extraBufferName = $"{destinationStem}.skin-fixes.bin";
					buffers.Add(new JObject
					{
						["byteLength"] = 0,
						["uri"] = extraBufferName
					});
					newBufferIndex = buffers.Count - 1;
				}

				AlignStream(jointBuffer, componentSize);
				int newBufferViewOffset = checked((int)jointBuffer.Position);
				byte[] convertedBytes = new byte[count * componentSize * 4];

				for (int i = 0; i < count; i++)
				{
					int sourceOffset = bufferViewByteOffset + accessorByteOffset + (i * stride);
					for (int componentIndex = 0; componentIndex < 4; componentIndex++)
					{
						int value = ReadUnsignedJointComponent(bufferBytes, sourceOffset + (componentIndex * componentSize), componentType);
						int clampedValue = Math.Min(value, Math.Max(0, jointCount - 1));
						int destinationOffset = (i * componentSize * 4) + (componentIndex * componentSize);
						WriteUnsignedJointComponent(convertedBytes, destinationOffset, componentType, clampedValue);
					}
				}

				jointBuffer.Write(convertedBytes, 0, convertedBytes.Length);

				JObject newBufferView = new()
				{
					["buffer"] = newBufferIndex,
					["byteOffset"] = newBufferViewOffset,
					["byteLength"] = convertedBytes.Length
				};

				if (bufferView["target"] != null)
				{
					newBufferView["target"] = bufferView["target"]!.DeepClone();
				}
				if (accessor["name"] != null)
				{
					newBufferView["name"] = $"{accessor["name"]!.Value<string>()}_ClampedBufferView";
				}

				bufferViews.Add(newBufferView);
				accessor["bufferView"] = bufferViews.Count - 1;
				accessor.Property("byteOffset")?.Remove();
			}
		}

		if (newBufferIndex >= 0)
		{
			byte[] bytes = jointBuffer.ToArray();
			JObject newBuffer = (JObject)buffers[newBufferIndex]!;
			newBuffer["byteLength"] = bytes.Length;
			File.WriteAllBytes(Path.Combine(destinationDirectory, newBuffer["uri"]!.Value<string>()!), bytes);
		}
	}

	private static void RewriteSkinWeightAccessors(JObject gltf, JArray accessors, JArray bufferViews, JArray buffers, IReadOnlyDictionary<int, byte[]> sourceBufferData, string destinationDirectory, string destinationStem)
	{
		Dictionary<int, int> meshSkinMap = GetMeshSkinMap(gltf);
		if (meshSkinMap.Count == 0)
		{
			return;
		}

		using MemoryStream weightBuffer = new();
		int newBufferIndex = -1;
		JArray meshes = (JArray?)gltf["meshes"] ?? [];

		foreach ((int meshIndex, _) in meshSkinMap.OrderBy(pair => pair.Key))
		{
			if (meshIndex < 0 || meshIndex >= meshes.Count || meshes[meshIndex] is not JObject mesh)
			{
				continue;
			}

			foreach (JObject primitive in mesh["primitives"]?.OfType<JObject>() ?? [])
			{
				if (primitive["attributes"] is not JObject attributes || attributes["WEIGHTS_0"]?.Type != JTokenType.Integer)
				{
					continue;
				}

				int accessorIndex = attributes["WEIGHTS_0"]!.Value<int>();
				if (accessorIndex < 0 || accessorIndex >= accessors.Count || accessors[accessorIndex] is not JObject accessor)
				{
					throw new InvalidDataException($"WEIGHTS_0 references an invalid accessor index {accessorIndex}.");
				}

				int bufferViewIndex = accessor["bufferView"]?.Value<int>() ?? -1;
				if (bufferViewIndex < 0 || bufferViewIndex >= bufferViews.Count || bufferViews[bufferViewIndex] is not JObject bufferView)
				{
					throw new InvalidDataException($"Accessor {accessorIndex} references an invalid bufferView.");
				}

				int sourceBufferIndex = bufferView["buffer"]?.Value<int>() ?? -1;
				if (!sourceBufferData.TryGetValue(sourceBufferIndex, out byte[]? bufferBytes))
				{
					throw new InvalidDataException($"bufferView {bufferViewIndex} references an unknown buffer index {sourceBufferIndex}.");
				}

				int componentType = accessor["componentType"]?.Value<int>() ?? 0;
				int componentSize = ComponentSize(componentType);
				int count = accessor["count"]?.Value<int>() ?? 0;
				int accessorByteOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
				int bufferViewByteOffset = bufferView["byteOffset"]?.Value<int>() ?? 0;
				int stride = bufferView["byteStride"]?.Value<int>() ?? (componentSize * 4);
				bool isNormalized = accessor["normalized"]?.Value<bool>() ?? false;

				if (newBufferIndex < 0)
				{
					string extraBufferName = $"{destinationStem}.weight-fixes.bin";
					buffers.Add(new JObject
					{
						["byteLength"] = 0,
						["uri"] = extraBufferName
					});
					newBufferIndex = buffers.Count - 1;
				}

				AlignStream(weightBuffer, sizeof(float));
				int newBufferViewOffset = checked((int)weightBuffer.Position);
				byte[] convertedBytes = new byte[count * sizeof(float) * 4];

				for (int i = 0; i < count; i++)
				{
					int sourceOffset = bufferViewByteOffset + accessorByteOffset + (i * stride);
					EnsureReadableRange(bufferBytes, sourceOffset, componentSize * 4, accessorIndex);

					float[] weights =
					[
						ReadWeightComponent(bufferBytes, sourceOffset, componentType, isNormalized),
						ReadWeightComponent(bufferBytes, sourceOffset + componentSize, componentType, isNormalized),
						ReadWeightComponent(bufferBytes, sourceOffset + (componentSize * 2), componentType, isNormalized),
						ReadWeightComponent(bufferBytes, sourceOffset + (componentSize * 3), componentType, isNormalized)
					];

					float sum = weights.Sum();
					if (sum > 0f)
					{
						for (int componentIndex = 0; componentIndex < weights.Length; componentIndex++)
						{
							weights[componentIndex] /= sum;
						}
					}
					else
					{
						weights[0] = 1f;
						weights[1] = 0f;
						weights[2] = 0f;
						weights[3] = 0f;
					}

					weights[3] = Math.Clamp(1f - (weights[0] + weights[1] + weights[2]), 0f, 1f);

					int destinationOffset = i * sizeof(float) * 4;
					BitConverter.GetBytes(weights[0]).CopyTo(convertedBytes, destinationOffset);
					BitConverter.GetBytes(weights[1]).CopyTo(convertedBytes, destinationOffset + sizeof(float));
					BitConverter.GetBytes(weights[2]).CopyTo(convertedBytes, destinationOffset + (sizeof(float) * 2));
					BitConverter.GetBytes(weights[3]).CopyTo(convertedBytes, destinationOffset + (sizeof(float) * 3));
				}

				weightBuffer.Write(convertedBytes, 0, convertedBytes.Length);

				JObject newBufferView = new()
				{
					["buffer"] = newBufferIndex,
					["byteOffset"] = newBufferViewOffset,
					["byteLength"] = convertedBytes.Length
				};

				if (bufferView["target"] != null)
				{
					newBufferView["target"] = bufferView["target"]!.DeepClone();
				}
				if (accessor["name"] != null)
				{
					newBufferView["name"] = $"{accessor["name"]!.Value<string>()}_FloatBufferView";
				}

				bufferViews.Add(newBufferView);
				accessor["bufferView"] = bufferViews.Count - 1;
				accessor["componentType"] = 5126;
				accessor.Property("byteOffset")?.Remove();
				accessor.Property("normalized")?.Remove();
			}
		}

		if (newBufferIndex >= 0)
		{
			byte[] bytes = weightBuffer.ToArray();
			JObject newBuffer = (JObject)buffers[newBufferIndex]!;
			newBuffer["byteLength"] = bytes.Length;
			File.WriteAllBytes(Path.Combine(destinationDirectory, newBuffer["uri"]!.Value<string>()!), bytes);
		}
	}

	private static HashSet<int> GetTexCoordAccessorIndices(JObject gltf)
	{
		HashSet<int> indices = [];

		foreach (JObject mesh in gltf["meshes"]?.OfType<JObject>() ?? [])
		{
			foreach (JObject primitive in mesh["primitives"]?.OfType<JObject>() ?? [])
			{
				if (primitive["attributes"] is not JObject attributes)
				{
					continue;
				}

				foreach (JProperty property in attributes.Properties())
				{
					if (!property.Name.StartsWith("TEXCOORD_", StringComparison.Ordinal))
					{
						continue;
					}

					if (property.Value.Type != JTokenType.Integer)
					{
						throw new InvalidDataException($"TEXCOORD attribute {property.Name} does not reference an accessor index.");
					}

					indices.Add(property.Value.Value<int>());
				}
			}
		}

		return indices;
	}

	private static Dictionary<int, string> GetMeshAccessorSemantics(JObject gltf, IReadOnlySet<string> semantics)
	{
		Dictionary<int, string> accessorSemantics = [];

		foreach (JObject mesh in gltf["meshes"]?.OfType<JObject>() ?? [])
		{
			foreach (JObject primitive in mesh["primitives"]?.OfType<JObject>() ?? [])
			{
				if (primitive["attributes"] is not JObject attributes)
				{
					continue;
				}

				foreach (JProperty property in attributes.Properties())
				{
					if (!semantics.Contains(property.Name) || property.Value.Type != JTokenType.Integer)
					{
						continue;
					}

					accessorSemantics[property.Value.Value<int>()] = property.Name;
				}
			}
		}

		return accessorSemantics;
	}

	private static Dictionary<int, int> GetMeshSkinMap(JObject gltf)
	{
		Dictionary<int, int> meshSkinMap = [];

		foreach (JObject node in gltf["nodes"]?.OfType<JObject>() ?? [])
		{
			if (node["mesh"]?.Type != JTokenType.Integer || node["skin"]?.Type != JTokenType.Integer)
			{
				continue;
			}

			meshSkinMap[node["mesh"]!.Value<int>()] = node["skin"]!.Value<int>();
		}

		return meshSkinMap;
	}

	private static int NormalizeOptimizedNodeScales(JArray? nodes)
	{
		if (nodes == null)
		{
			return 0;
		}

		int normalizedCount = 0;
		foreach (JObject node in nodes.OfType<JObject>())
		{
			if (node["scale"] is not JArray scale || scale.Count != 3)
			{
				continue;
			}

			Vector3 currentScale = new(
				scale[0]!.Value<float>(),
				scale[1]!.Value<float>(),
				scale[2]!.Value<float>());

			if (NearlyEqual(currentScale.X, currentScale.Y) && NearlyEqual(currentScale.Y, currentScale.Z))
			{
				continue;
			}

			float averageScale = (currentScale.X + currentScale.Y + currentScale.Z) / 3f;
			scale[0] = averageScale;
			scale[1] = averageScale;
			scale[2] = averageScale;
			normalizedCount++;
		}

		return normalizedCount;
	}

	private static void NormalizeKnownAttributeAccessors(JObject gltf, JArray accessors)
	{
		foreach (JObject mesh in gltf["meshes"]?.OfType<JObject>() ?? [])
		{
			foreach (JObject primitive in mesh["primitives"]?.OfType<JObject>() ?? [])
			{
				if (primitive["attributes"] is not JObject attributes)
				{
					continue;
				}

				foreach (JProperty property in attributes.Properties())
				{
					if (property.Value.Type != JTokenType.Integer)
					{
						continue;
					}

					int accessorIndex = property.Value.Value<int>();
					if (accessorIndex < 0 || accessorIndex >= accessors.Count || accessors[accessorIndex] is not JObject accessor)
					{
						throw new InvalidDataException($"Mesh attribute {property.Name} references an invalid accessor index {accessorIndex}.");
					}

					if (property.Name == "NORMAL")
					{
						if (string.Equals(accessor["type"]?.Value<string>(), "VEC4", StringComparison.Ordinal))
						{
							accessor["type"] = "VEC3";
						}
						EnsureQuantizedAccessorIsNormalized(accessor);
						continue;
					}

					if (property.Name == "TANGENT")
					{
						EnsureQuantizedAccessorIsNormalized(accessor);
						continue;
					}

					if (property.Name.StartsWith("COLOR_", StringComparison.Ordinal))
					{
						EnsureQuantizedAccessorIsNormalized(accessor);
						continue;
					}

					if (property.Name.StartsWith("TEXCOORD_", StringComparison.Ordinal))
					{
						EnsureQuantizedAccessorIsNormalized(accessor);
					}
				}
			}
		}
	}

	private static void EnsureDeclaredExtensions(JObject gltf, JArray accessors)
	{
		bool requiresMeshQuantization = false;

		foreach (JObject mesh in gltf["meshes"]?.OfType<JObject>() ?? [])
		{
			foreach (JObject primitive in mesh["primitives"]?.OfType<JObject>() ?? [])
			{
				if (primitive["attributes"] is not JObject attributes)
				{
					continue;
				}

				foreach (JProperty property in attributes.Properties())
				{
					if (property.Value.Type != JTokenType.Integer)
					{
						continue;
					}

					string semantic = property.Name;
					if (semantic.StartsWith("JOINTS_", StringComparison.Ordinal) || semantic.StartsWith("WEIGHTS_", StringComparison.Ordinal))
					{
						continue;
					}

					int accessorIndex = property.Value.Value<int>();
					if (accessorIndex < 0 || accessorIndex >= accessors.Count || accessors[accessorIndex] is not JObject accessor)
					{
						throw new InvalidDataException($"Mesh attribute {semantic} references an invalid accessor index {accessorIndex}.");
					}

					int componentType = accessor["componentType"]?.Value<int>() ?? 0;
					if (componentType != 5126)
					{
						requiresMeshQuantization = true;
						break;
					}
				}

				if (requiresMeshQuantization)
				{
					break;
				}
			}

			if (requiresMeshQuantization)
			{
				break;
			}
		}

		if (requiresMeshQuantization)
		{
			AppendUniqueString((JArray?)(gltf["extensionsUsed"] ??= new JArray()), "KHR_mesh_quantization");
			AppendUniqueString((JArray?)(gltf["extensionsRequired"] ??= new JArray()), "KHR_mesh_quantization");
		}
	}

	private static void ValidateRepairedGltf(string destinationGltfPath)
	{
		_ = ModelRoot.Load(destinationGltfPath, new ReadSettings
		{
			Validation = ValidationMode.Strict
		});
	}

	private static byte[] ReadBufferBytes(string uri, string sourceDirectory)
	{
		if (uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
		{
			int commaIndex = uri.IndexOf(',');
			if (commaIndex < 0)
			{
				throw new InvalidDataException("Data URI buffer is missing a payload separator.");
			}

			return Convert.FromBase64String(uri[(commaIndex + 1)..]);
		}

		string sourcePath = ResolveResourcePath(sourceDirectory, uri);
		if (!File.Exists(sourcePath))
		{
			throw new FileNotFoundException($"Referenced glTF buffer is missing: {sourcePath}", sourcePath);
		}

		return File.ReadAllBytes(sourcePath);
	}

	private static string ResolveResourcePath(string sourceDirectory, string uri)
	{
		string relativePath = uri.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);
		string combinedPath = Path.GetFullPath(Path.Combine(sourceDirectory, relativePath));
		if (File.Exists(combinedPath) || Directory.Exists(combinedPath))
		{
			return combinedPath;
		}

		string currentPath = Path.GetFullPath(sourceDirectory);
		bool resolvedAllParts = true;
		foreach (string part in relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
		{
			if (part == ".")
			{
				continue;
			}
			if (part == "..")
			{
				currentPath = Directory.GetParent(currentPath)?.FullName ?? currentPath;
				continue;
			}

			string candidatePath = Path.Combine(currentPath, part);
			if (File.Exists(candidatePath) || Directory.Exists(candidatePath))
			{
				currentPath = candidatePath;
				continue;
			}

			if (!Directory.Exists(currentPath))
			{
				resolvedAllParts = false;
				break;
			}

			string? matchedEntry = Directory
				.EnumerateFileSystemEntries(currentPath)
				.FirstOrDefault(entry => string.Equals(Path.GetFileName(entry), part, StringComparison.OrdinalIgnoreCase));

			if (matchedEntry == null)
			{
				resolvedAllParts = false;
				break;
			}

			currentPath = matchedEntry;
		}

		if (resolvedAllParts && (File.Exists(currentPath) || Directory.Exists(currentPath)))
		{
			return currentPath;
		}

		string fileName = Path.GetFileName(relativePath);
		if (string.IsNullOrWhiteSpace(fileName))
		{
			return combinedPath;
		}

		string? fallbackMatch = FindResourceByFileName(sourceDirectory, fileName);
		return fallbackMatch ?? combinedPath;
	}

	private static void AlignStream(Stream stream, int alignment)
	{
		while (stream.Position % alignment != 0)
		{
			stream.WriteByte(0);
		}
	}

	private static void EnsureReadableRange(byte[] bufferBytes, int offset, int length, int accessorIndex)
	{
		if (offset < 0 || length < 0 || offset + length > bufferBytes.Length)
		{
			throw new InvalidDataException($"Accessor {accessorIndex} reads outside of its referenced buffer.");
		}
	}

	private static bool NearlyEqual(float left, float right)
	{
		return MathF.Abs(left - right) <= 1e-6f;
	}

	private static string? FindResourceByFileName(string sourceDirectory, string fileName)
	{
		DirectoryInfo? current = new(Path.GetFullPath(sourceDirectory));

		while (current != null)
		{
			string? match = Directory
				.EnumerateFiles(current.FullName, "*", SearchOption.AllDirectories)
				.FirstOrDefault(path => string.Equals(Path.GetFileName(path), fileName, StringComparison.OrdinalIgnoreCase));

			if (match != null)
			{
				return match;
			}

			current = current.Parent;
		}

		return null;
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
			_ => throw new InvalidDataException($"Unsupported component type {componentType}.")
		};
	}

	private static float ReadSignedNormalizedComponent(byte[] bufferBytes, int offset, int componentType)
	{
		return componentType switch
		{
			5120 => Math.Max(-1f, (sbyte)bufferBytes[offset] / 127f),
			5122 => Math.Max(-1f, BitConverter.ToInt16(bufferBytes, offset) / 32767f),
			5126 => BitConverter.ToSingle(bufferBytes, offset),
			_ => throw new InvalidDataException($"Unsupported signed normalized component type {componentType}.")
		};
	}

	private static float ReadWeightComponent(byte[] bufferBytes, int offset, int componentType, bool normalized)
	{
		return componentType switch
		{
			5121 => normalized ? bufferBytes[offset] / 255f : bufferBytes[offset],
			5123 => normalized ? BitConverter.ToUInt16(bufferBytes, offset) / 65535f : BitConverter.ToUInt16(bufferBytes, offset),
			5126 => BitConverter.ToSingle(bufferBytes, offset),
			_ => throw new InvalidDataException($"Unsupported WEIGHTS component type {componentType}.")
		};
	}

	private static int ReadUnsignedJointComponent(byte[] bufferBytes, int offset, int componentType)
	{
		return componentType switch
		{
			5121 => bufferBytes[offset],
			5123 => BitConverter.ToUInt16(bufferBytes, offset),
			_ => throw new InvalidDataException($"Unsupported JOINTS component type {componentType}.")
		};
	}

	private static void WriteUnsignedJointComponent(byte[] bufferBytes, int offset, int componentType, int value)
	{
		switch (componentType)
		{
			case 5121:
				bufferBytes[offset] = checked((byte)value);
				break;
			case 5123:
				BitConverter.GetBytes(checked((ushort)value)).CopyTo(bufferBytes, offset);
				break;
			default:
				throw new InvalidDataException($"Unsupported JOINTS component type {componentType}.");
		}
	}

	private static void EnsureQuantizedAccessorIsNormalized(JObject accessor)
	{
		int componentType = accessor["componentType"]?.Value<int>() ?? 0;
		if (componentType == 5126)
		{
			accessor.Property("normalized")?.Remove();
			return;
		}

		accessor["normalized"] = true;
	}

	private static void AppendUniqueString(JArray? array, string value)
	{
		if (array == null || array.Any(token => string.Equals(token.Value<string>(), value, StringComparison.Ordinal)))
		{
			return;
		}

		array.Add(value);
	}
}
