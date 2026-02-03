using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using g3;

namespace Scone;

public static class BtgRaycast
{
	/// <summary>
	/// Casts a vertical ray from 'queryPoint' downwards and returns the Z coordinate of intersection.
	/// Returns int.MinValue if no intersection is found.
	/// </summary>
	public static double RaycastZ(DMesh3 mesh, Vector3d queryPoint)
	{
		// Build a spatial acceleration structure
		DMeshAABBTree3 tree = new(mesh, autoBuild: true);

		// Cast a vertical ray downwards (along -Z)
		Ray3d ray = new(queryPoint, Vector3d.AxisZ * -1);

		int hit_tid = tree.FindNearestHitTriangle(ray);
		if (hit_tid == DMesh3.InvalidID)
			return int.MinValue;

		IntrRay3Triangle3 intr = MeshQueries.TriangleIntersection(mesh, hit_tid, ray);
		Vector3d hitPoint = ray.PointAt(intr.RayParameter);

		return hitPoint.z;
	}
}

public class BtgParseResult
{
	public DMesh3 Mesh { get; set; }
	public Vector3d? BoundingSphereCenter { get; set; }
	public double? BoundingSphereRadius { get; set; }
}

public static class BtgParser
{
	public static BtgParseResult Parse(byte[] data)
	{
		using MemoryStream ms = new(data);
		using BinaryReader br = new(ms);

		// ----- HEADER -----
		ushort version = br.ReadUInt16();
		ushort magic = br.ReadUInt16(); // 'SG'
		uint creationTime = br.ReadUInt32();
		ushort objectCount = br.ReadUInt16();

		Logger.Debug($"BTG Header: version={version}, magic=0x{magic:X4}, time={creationTime}, objects={objectCount}");

		if (magic != 0x5347)
		{
			Logger.Error($"Invalid BTG file: expected magic 0x5347 but got 0x{magic:X4}");
			throw new InvalidDataException("Invalid BTG file");
		}

		if (objectCount > 10000)
		{
			Logger.Warning($"Suspicious object count {objectCount}. File may be corrupted.");
			return new BtgParseResult();
		}

		DMesh3 mesh = new();

		BtgParseResult result = new()
		{
			Mesh = mesh
		};

		// ----- OBJECT LOOP -----
		for (int i = 0; i < objectCount; i++)
		{
			// Check if we have enough bytes to read object header
			if (br.BaseStream.Position + 5 > br.BaseStream.Length)
			{
					Logger.Warning($"Not enough data for object {i} header. Stopping parse.");
					break;
			}

			byte objType = br.ReadByte();
			ushort propCount = br.ReadUInt16();
			ushort elemCount = br.ReadUInt16();

			// Sanity check: if propCount or elemCount are absurdly high, the file is likely corrupted
			if (propCount > 1000 || elemCount > 100000)
			{
					Logger.Warning($"Object {i} has suspicious counts (props={propCount}, elems={elemCount}). Skipping.");
					break;
			}

			// ----- PROPERTIES (ignored for bounding sphere) -----
			byte indexTypeFlags = 0;

			for (int p = 0; p < propCount; p++)
			{
				// Check if we can read property header
				if (br.BaseStream.Position + 5 > br.BaseStream.Length)
				{
						Logger.Warning($"Not enough data for property {p} header. Stopping.");
						break;
				}

				byte propType = br.ReadByte();
				uint propSize = br.ReadUInt32();
				long propStart = br.BaseStream.Position;
				long propEnd = propStart + propSize;

				// Sanity check: property size should be reasonable
				if (propSize > br.BaseStream.Length || propSize > 100_000_000)
				{
						Logger.Warning($"Property {p} type {propType} has invalid size {propSize}. File may be corrupted. Stopping parse.");
						return result;
				}

				// Validate that we can actually read this property
				if (propEnd > br.BaseStream.Length)
				{
						Logger.Warning($"Property {p} type {propType} size {propSize} extends beyond stream (start={propStart}, end={propEnd}, length={br.BaseStream.Length}). Stopping parse.");
						return result;
				}

				if (propType == 1 && propSize > 0) // Index Types
				{
					indexTypeFlags = br.ReadByte();
					// Skip any remaining bytes in this property
					long bytesRead = br.BaseStream.Position - propStart;
					if (bytesRead < propSize)
					{
                        _ = br.BaseStream.Seek(propSize - bytesRead, SeekOrigin.Current);
					}
				}
				else
				{
                    // Skip the entire property
                    _ = br.BaseStream.Seek(propSize, SeekOrigin.Current);
				}

				// Ensure we're at the correct position
				if (br.BaseStream.Position != propEnd)
				{
						Logger.Warning($"Position mismatch after property {p}. Expected {propEnd}, got {br.BaseStream.Position}. Correcting.");
						br.BaseStream.Position = propEnd;
				}
			}

			// ----- ELEMENTS -----
			for (int e = 0; e < elemCount; e++)
			{
				// Check if we can read element size
				if (br.BaseStream.Position + 4 > br.BaseStream.Length)
				{
						Logger.Warning($"Not enough data for element {e} size. Stopping.");
						break;
				}

				uint elemSize = br.ReadUInt32();
				long elemStart = br.BaseStream.Position;
				long elemEnd = elemStart + elemSize;

				// Sanity check: element size should be reasonable
				if (elemSize > br.BaseStream.Length || elemSize > 100_000_000)
				{
						Logger.Warning($"Element {e} has invalid size {elemSize}. File may be corrupted. Stopping parse.");
						return result;
				}

				// Validate element bounds
				if (elemEnd > br.BaseStream.Length)
				{
						Logger.Warning($"Element {e} size {elemSize} extends beyond stream (start={elemStart}, end={elemEnd}, length={br.BaseStream.Length}). Stopping parse.");
						return result;
				}

				switch (objType)
				{
					// ---- Bounding Sphere (Type 0) ----
					case 0:
						{
							if (elemSize >= 28)
							{
								double x = br.ReadDouble();
								double y = br.ReadDouble();
								double z = br.ReadDouble();
								float radius = br.ReadSingle();

								// Only the LAST sphere should be used
								result.BoundingSphereCenter = new Vector3d(x, y, z);
								result.BoundingSphereRadius = radius;
							}
							break;
						}

					// ---- Vertex List (Type 1) ----
					case 1:
						{
							int vertCount = (int)elemSize / 12;
							for (int v = 0; v < vertCount; v++)
							{
								float x = br.ReadSingle();
								float y = br.ReadSingle();
								float z = br.ReadSingle();

                                _ = mesh.AppendVertex(new Vector3d(x, y, z));
							}
							break;
						}

					// ---- Individual Triangles (Type 10) ----
					case 10:
						ReadTriangleElements(br, mesh, elemSize, indexTypeFlags, objType);
						break;

					// ---- Triangle Strip (Type 11) ----
					case 11:
						ReadTriangleStrip(br, mesh, elemSize, indexTypeFlags);
						break;

					// ---- Triangle Fan (Type 12) ----
					case 12:
						ReadTriangleFan(br, mesh, elemSize, indexTypeFlags);
						break;

					default:
                        _ = br.BaseStream.Seek(elemSize, SeekOrigin.Current);
						break;
				}

				// Ensure we're at the correct position after element
				if (br.BaseStream.Position > elemEnd)
				{
						Logger.Warning($"Read past element boundary. Position={br.BaseStream.Position}, Expected={elemEnd}");
					}

				// Always seek to the correct end position
				if (br.BaseStream.Position != elemEnd && elemEnd <= br.BaseStream.Length)
				{
					br.BaseStream.Position = elemEnd;
				}
			}
		}

		return result;
	}

	// ===== Helpers that respect index type flags =====

	private static int CalcTupleSize(byte flags, byte objType)
	{
		if (flags == 0)
		{
			if (objType == 9) return 2;       // Points default: vertex only
			return 4;                         // vertex + texcoord default
		}

		int size = 0;
		if ((flags & 1) != 0) size += 2;
		if ((flags & 2) != 0) size += 2;
		if ((flags & 4) != 0) size += 2;
		if ((flags & 8) != 0) size += 2;
		return size;
	}

	private static void ReadTriangleElements(BinaryReader br, DMesh3 mesh, uint elemSize, byte flags, byte objType)
	{
		int tupleSize = CalcTupleSize(flags, objType);
		int count = (int)elemSize / tupleSize;

		List<int> verts = new(count);

		for (int i = 0; i < count; i++)
			verts.Add(ReadVertexIndex(br, tupleSize));

		for (int i = 0; i + 2 < verts.Count; i += 3)
            _ = mesh.AppendTriangle(verts[i], verts[i + 2], verts[i + 1]);
	}

	private static void ReadTriangleStrip(BinaryReader br, DMesh3 mesh, uint elemSize, byte flags)
	{
		int tupleSize = CalcTupleSize(flags, 11);
		int count = (int)elemSize / tupleSize;
		List<int> v = new(count);

		for (int i = 0; i < count; i++)
			v.Add(ReadVertexIndex(br, tupleSize));

		for (int i = 0; i + 2 < v.Count; i++)
		{
			if ((i & 1) == 0)
                _ = mesh.AppendTriangle(v[i], v[i + 1], v[i + 2]);
			else
                _ = mesh.AppendTriangle(v[i + 1], v[i], v[i + 2]);
		}
	}

	private static void ReadTriangleFan(BinaryReader br, DMesh3 mesh, uint elemSize, byte flags)
	{
		int tupleSize = CalcTupleSize(flags, 12);
		int count = (int)elemSize / tupleSize;
		List<int> v = new(count);

		for (int i = 0; i < count; i++)
			v.Add(ReadVertexIndex(br, tupleSize));

		for (int i = 1; i + 1 < v.Count; i++)
            _ = mesh.AppendTriangle(v[0], v[i], v[i + 1]);
	}

	// Only read vertex index, skip rest of tuple
	private static int ReadVertexIndex(BinaryReader br, int tupleSize)
	{
		ushort v = br.ReadUInt16();
		int skip = tupleSize - 2;
		if (skip > 0) _ = br.ReadBytes(skip);
		return v;
	}
}

public class Terrain
{
	private static readonly double[,] LatitudeIndex = { { 89, 12 }, { 86, 4 }, { 83, 2 }, { 76, 1 }, { 62, 0.5 }, { 22, 0.25 }, { 0, 0.125 } };
	private static readonly HttpClientHandler handler = new() { ServerCertificateCustomValidationCallback = (message, cert, chain, errors) => true };
	private static readonly HttpClient client = new(handler);
	private static Dictionary<int, TileKey> tileCache = [];
	private const double Wgs84A = 6_378_137.0;
	private const double Wgs84E2 = 6.69437999014e-3;

	public static double GetElevation(double latitude, double longitude)
	{
		int index = GetTileIndex(latitude, longitude);
		string lonHemi = longitude >= 0 ? "e" : "w";
		string latHemi = latitude >= 0 ? "n" : "s";
		string terrainDir = $"Terrain/{lonHemi}{Math.Abs(Math.Floor(longitude / 10)) * 10:000}{latHemi}{Math.Abs(Math.Floor(latitude / 10)) * 10:00}/{lonHemi}{Math.Abs(Math.Floor(longitude)):000}{latHemi}{Math.Abs(Math.Floor(latitude)):00}";
		string urlTopLevel = $"https://terramaster.flightgear.org/terrasync/ws2/{terrainDir}";
		double elevation = 0;
		try
		{
			if (!tileCache.TryGetValue(index, out TileKey? value))
			{
				byte[] stgData = client.GetByteArrayAsync($"{urlTopLevel}/{index}.stg").Result;
				MatchCollection matches = new Regex(@"OBJECT(?:_BASE)? (.+\.btg)", RegexOptions.Multiline).Matches(Encoding.UTF8.GetString(stgData));
				List<BtgParseResult> meshes = [];
				foreach (Match match in matches)
				{
					Logger.Debug($"Fetching BTG data from {urlTopLevel}/{match.Groups[1].Value}.gz");
					byte[] btgGzData = client.GetByteArrayAsync($"{urlTopLevel}/{match.Groups[1].Value}.gz").Result;
					using MemoryStream compressedStream = new(btgGzData);
					using GZipStream gzipStream = new(compressedStream, CompressionMode.Decompress);
					using MemoryStream decompressedStream = new();
					gzipStream.CopyTo(decompressedStream);
                    _ = decompressedStream.ToArray();
					byte[] btgData = decompressedStream.ToArray();
					meshes.Add(BtgParser.Parse(btgData));
				}

				value = new TileKey()
				{
					Index = index,
					Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
					Locked = false,
					Models = [.. meshes.Select(BuildTileModel)]
				};
                tileCache[index] = value;
			}

			value.Locked = true;
			foreach (TileModel model in value.Models)
			{
				double elevationCur = SampleAltitude(model, latitude, longitude);
				elevation = elevationCur > elevation ? elevationCur : elevation;
			}
		}
		catch (AggregateException e)
		{
			Logger.Error($"Error fetching BTG data from {$"{urlTopLevel}/{index}.stg"}: {e.Message}");

			tileCache[index] = new TileKey()
			{
				Index = index,
				Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
				Locked = false,
				Models = []
			};
		}
		return elevation;
	}

	public static int GetTileIndex(double lat, double lon)
	{
		if (Math.Abs(lat) > 90 || Math.Abs(lon) > 180)
		{
			Logger.Error("Latitude or longitude out of range");
			return 0;
		}
		else
		{
			double lookup = Math.Abs(lat);
			double tileWidth = 0;
			for (int i = 0; i < LatitudeIndex.Length; i++)
			{
				if (lookup >= LatitudeIndex[i, 0])
				{
					tileWidth = LatitudeIndex[i, 1];
					break;
				}
			}
			int baseX = (int)Math.Floor(Math.Floor(lon / tileWidth) * tileWidth);
			int x = (int)Math.Floor((lon - baseX) / tileWidth);
			int baseY = (int)Math.Floor(lat);
			int y = (int)Math.Truncate((lat - baseY) * 8);
			return ((baseX + 180) << 14) + ((baseY + 90) << 6) + (y << 3) + x;
		}
	}

	public static (double lat, double lon) GetLatLon(int tileIndex)
	{
		// Extract x, y, baseY, baseX from the tile index (reverse of GetTileIndex bit packing)
		// GetTileIndex packs as: ((baseX + 180) << 14) + ((baseY + 90) << 6) + (y << 3) + x
		int x = tileIndex & 0b111; // last 3 bits
		int y = (tileIndex >> 3) & 0b111; // next 3 bits (not 6!)
		int baseY = ((tileIndex >> 6) & 0b11111111) - 90; // next 8 bits, then subtract 90
		int baseX = (tileIndex >> 14) - 180; // remaining bits, then subtract 180

		// Determine the tileWidth for this latitude band
		double lookup = Math.Abs(baseY);
		double tileWidth = 0;
		for (int i = 0; i < LatitudeIndex.Length; i++)
		{
			if (lookup >= LatitudeIndex[i, 0])
			{
				tileWidth = LatitudeIndex[i, 1];
				break;
			}
		}

		// Reconstruct the coordinates (reverse of GetTileIndex coordinate calculation)
		double lat = baseY + y / 8.0;
		double lon = baseX + x * tileWidth;

		return (lat, lon);
	}

	private class TileKey
	{
		public int Index;
		public long Timestamp;
		public bool Locked;
		public List<TileModel> Models;
	}

	private static byte[]? ReadBtgData(string gzPath, string btgPath)
	{
		if (File.Exists(gzPath))
		{
			using FileStream fs = new(gzPath, FileMode.Open, FileAccess.Read);
			using GZipStream gzip = new(fs, CompressionMode.Decompress);
			using MemoryStream ms = new();
			gzip.CopyTo(ms);
			return ms.ToArray();
		}

		if (File.Exists(btgPath))
		{
			return File.ReadAllBytes(btgPath);
		}

		return null;
	}

	private static TileModel BuildTileModel(BtgParseResult parsed)
	{
		DMesh3 mesh = parsed.Mesh;
		Vector3d center = parsed.BoundingSphereCenter ?? Vector3d.Zero;

		LlaVertex?[] vertices = new LlaVertex?[mesh.MaxVertexID];
		for (int vid = 0; vid < mesh.MaxVertexID; vid++)
		{
			if (!mesh.IsVertex(vid)) continue;
			Vector3d rel = mesh.GetVertex(vid);
			Vector3d abs = center + rel;
			LlaVertex lla = EcefToLla(abs.x, abs.y, abs.z);
			vertices[vid] = lla;
		}

		List<TriangleModel> triangles = [];
		for (int tid = 0; tid < mesh.MaxTriangleID; tid++)
		{
			if (!mesh.IsTriangle(tid)) continue;
			Index3i tri = mesh.GetTriangle(tid);
			if (tri.a < 0 || tri.b < 0 || tri.c < 0) continue;
			if (tri.a >= vertices.Length || tri.b >= vertices.Length || tri.c >= vertices.Length) continue;
			LlaVertex? v1 = vertices[tri.a];
			LlaVertex? v2 = vertices[tri.b];
			LlaVertex? v3 = vertices[tri.c];
			if (v1 == null || v2 == null || v3 == null) continue;

			double minLat = Math.Min(v1.Value.Lat, Math.Min(v2.Value.Lat, v3.Value.Lat));
			double maxLat = Math.Max(v1.Value.Lat, Math.Max(v2.Value.Lat, v3.Value.Lat));
			double minLon = Math.Min(v1.Value.Lon, Math.Min(v2.Value.Lon, v3.Value.Lon));
			double maxLon = Math.Max(v1.Value.Lon, Math.Max(v2.Value.Lon, v3.Value.Lon));
			triangles.Add(new TriangleModel(tri.a, tri.b, tri.c, minLat, maxLat, minLon, maxLon));
		}

		return new TileModel(vertices, triangles);
	}

	private static double SampleAltitude(TileModel model, double lat, double lon)
	{
		double? nearest = null;
		double nearestDist = double.MaxValue;

		foreach (TriangleModel tri in model.Triangles)
		{
			if (lat < tri.MinLat || lat > tri.MaxLat || lon < tri.MinLon || lon > tri.MaxLon)
			{
				continue;
			}

			LlaVertex v1 = model.Vertices[tri.A]!.Value;
			LlaVertex v2 = model.Vertices[tri.B]!.Value;
			LlaVertex v3 = model.Vertices[tri.C]!.Value;

			if (TryBarycentric(lon, lat, v1.Lon, v1.Lat, v2.Lon, v2.Lat, v3.Lon, v3.Lat, out double u, out double v, out double w))
			{
				return (u * v1.Alt) + (v * v2.Alt) + (w * v3.Alt);
			}
		}

		for (int i = 0; i < model.Vertices.Length; i++)
		{
			if (model.Vertices[i] == null) continue;
			LlaVertex v = model.Vertices[i]!.Value;
			double dx = lon - v.Lon;
			double dy = lat - v.Lat;
			double dist = (dx * dx) + (dy * dy);
			if (dist < nearestDist)
			{
				nearestDist = dist;
				nearest = v.Alt;
			}
		}

		return nearest ?? 0;
	}

	private static bool TryBarycentric(
		double px,
		double py,
		double ax,
		double ay,
		double bx,
		double by,
		double cx,
		double cy,
		out double u,
		out double v,
		out double w)
	{
		double v0x = bx - ax;
		double v0y = by - ay;
		double v1x = cx - ax;
		double v1y = cy - ay;
		double v2x = px - ax;
		double v2y = py - ay;

		double d00 = v0x * v0x + v0y * v0y;
		double d01 = v0x * v1x + v0y * v1y;
		double d11 = v1x * v1x + v1y * v1y;
		double d20 = v2x * v0x + v2y * v0y;
		double d21 = v2x * v1x + v2y * v1y;

		double denom = d00 * d11 - d01 * d01;
		if (Math.Abs(denom) < 1e-12)
		{
			u = v = w = 0;
			return false;
		}

		v = (d11 * d20 - d01 * d21) / denom;
		w = (d00 * d21 - d01 * d20) / denom;
		u = 1 - v - w;
		return u >= -1e-6 && v >= -1e-6 && w >= -1e-6;
	}

	private static LlaVertex EcefToLla(double x, double y, double z)
	{
		double a = Wgs84A;
		double e2 = Wgs84E2;
		double b = a * Math.Sqrt(1 - e2);
		double ep2 = (a * a - b * b) / (b * b);
		double p = Math.Sqrt((x * x) + (y * y));
		double th = Math.Atan2(a * z, b * p);
		double lon = Math.Atan2(y, x);
		double lat = Math.Atan2(z + (ep2 * b * Math.Pow(Math.Sin(th), 3)), p - (e2 * a * Math.Pow(Math.Cos(th), 3)));
		double sinLat = Math.Sin(lat);
		double n = a / Math.Sqrt(1 - e2 * sinLat * sinLat);
		double alt = (p / Math.Cos(lat)) - n;

		return new LlaVertex(lat * 180 / Math.PI, lon * 180 / Math.PI, alt);
	}

	private readonly record struct TileInfo(int Index, string RelativePath, int BaseX, int BaseY, int X, int Y, double TileWidth);
	private readonly record struct TriangleModel(int A, int B, int C, double MinLat, double MaxLat, double MinLon, double MaxLon);
	private readonly record struct LlaVertex(double Lat, double Lon, double Alt);
	private readonly record struct TileModel(LlaVertex?[] Vertices, List<TriangleModel> Triangles);
}