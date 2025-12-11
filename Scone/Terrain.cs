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

		if (magic != 0x5347)
			throw new InvalidDataException("Invalid BTG file");

		DMesh3 mesh = new();

		BtgParseResult result = new()
		{
			Mesh = mesh
		};

		// ----- OBJECT LOOP -----
		for (int i = 0; i < objectCount; i++)
		{
			byte objType = br.ReadByte();
			ushort propCount = br.ReadUInt16();
			ushort elemCount = br.ReadUInt16();

			// ----- PROPERTIES (ignored for bounding sphere) -----
			byte indexTypeFlags = 0;

			for (int p = 0; p < propCount; p++)
			{
				byte propType = br.ReadByte(); // run this with LTFM to get an error
				uint propSize = br.ReadUInt32();
				long propStart = br.BaseStream.Position;

				if (propType == 1 && propSize > 0) // Index Types
				{
					indexTypeFlags = br.ReadByte();
				}
				else
				{
					br.ReadBytes((int)propSize);
				}

				Console.WriteLine($"Skipping property type {propType} size {propSize} at {propStart}, length {br.BaseStream.Length}");
				br.BaseStream.Position = propStart + propSize; // run this with EFHK or OKKK to get an error
			}

			// ----- ELEMENTS -----
			for (int e = 0; e < elemCount; e++)
			{
				uint elemSize = br.ReadUInt32();
				long elemStart = br.BaseStream.Position;

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

								mesh.AppendVertex(new Vector3d(x, y, z));
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
						br.BaseStream.Seek(elemSize, SeekOrigin.Current);
						break;
				}

				br.BaseStream.Position = elemStart + elemSize;
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
			mesh.AppendTriangle(verts[i], verts[i + 2], verts[i + 1]);
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
				mesh.AppendTriangle(v[i], v[i + 1], v[i + 2]);
			else
				mesh.AppendTriangle(v[i + 1], v[i], v[i + 2]);
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
			mesh.AppendTriangle(v[0], v[i], v[i + 1]);
	}

	// Only read vertex index, skip rest of tuple
	private static int ReadVertexIndex(BinaryReader br, int tupleSize)
	{
		ushort v = br.ReadUInt16();
		int skip = tupleSize - 2;
		if (skip > 0) br.ReadBytes(skip);
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
		string urlTopLevel = $"https://terramaster.flightgear.org/terrasync/ws3/{terrainDir}";
		double elevation = 0;
		try
		{
			if (!tileCache.ContainsKey(index))
			{
				byte[] stgData = client.GetByteArrayAsync($"{urlTopLevel}/{index}.stg").Result;
				MatchCollection matches = new Regex(@"OBJECT (.+\.btg)", RegexOptions.Multiline).Matches(Encoding.UTF8.GetString(stgData));
				Console.WriteLine($"Found {matches.Count} BTG files in index {index}");
				List<BtgParseResult> meshes = [];
				foreach (Match match in matches)
				{
					byte[] btgGzData = client.GetByteArrayAsync($"{urlTopLevel}/{match.Groups[1].Value}.gz").Result;
					using MemoryStream compressedStream = new(btgGzData);
					using GZipStream gzipStream = new(compressedStream, CompressionMode.Decompress);
					using MemoryStream decompressedStream = new();
					gzipStream.CopyTo(decompressedStream);
					decompressedStream.ToArray();
					byte[] btgData = decompressedStream.ToArray();
					meshes.Add(BtgParser.Parse(btgData));
				}
				tileCache[index] = new TileKey()
				{
					Index = index,
					Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
					Locked = false,
					Meshes = meshes
				};
			}
			tileCache[index].Locked = true;
			foreach (BtgParseResult mesh in tileCache[index].Meshes)
			{
				double sinLat = Math.Sin(latitude * Math.PI / 180.0);
				double cosLat = Math.Cos(latitude * Math.PI / 180.0);
				double sinLon = Math.Sin(longitude * Math.PI / 180.0);
				double cosLon = Math.Cos(longitude * Math.PI / 180.0);
				double n = Wgs84A / Math.Sqrt(1 - Wgs84E2 * sinLat * sinLat);
				double x = n * cosLat * cosLon;
				double y = n * cosLat * sinLon;
				double z = n * (1 - Wgs84E2) * sinLat;
				Vector3d ecef = new(x, y, z);
				Vector3d center = mesh.BoundingSphereCenter ?? Vector3d.Zero;
				Vector3d queryPoint = ecef - center + new Vector3d(0, 0, 10000);
				Console.WriteLine($"Query Point: {queryPoint}");
				elevation = BtgRaycast.RaycastZ(mesh.Mesh, queryPoint);
			}
		}
		catch (AggregateException e)
		{
			Console.WriteLine($"Error fetching BTG data from {$"{urlTopLevel}/{index}.stg"}: {e.Message}");
		}
		Console.WriteLine($"Elevation: {elevation} meters");
		return 0 /* elevation */;
	}

	public static int GetTileIndex(double lat, double lon)
	{
		if (Math.Abs(lat) > 90 || Math.Abs(lon) > 180)
		{
			Console.WriteLine("Latitude or longitude out of range");
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
		public List<BtgParseResult> Meshes;
	}
}