using System.Globalization;
using System.Numerics;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Newtonsoft.Json.Linq;
using SharpGLTF.Geometry;
using SharpGLTF.Geometry.VertexTypes;
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
	private int modelsProcessed = 0;
	private int totalModelCount = 0;

	// Track which GUIDs have models
	HashSet<Guid> guidsWithModels = [];
	Dictionary<int, List<ModelReference>> modelReferencesByTile = [];
	Dictionary<Guid, List<LibraryObject>> libraryObjects = [];
	Dictionary<string, List<SimObject>> simObjects = [];
	Dictionary<int, Dictionary<string, SimObject>> simObjectsByTile = [];
	List<Airport> airports = [];
	private static readonly Matrix4x4 FlipZMatrix = Matrix4x4.CreateScale(1f, 1f, -1f);

	public void ConvertScenery(string inputPath, string outputPath, bool isGltf, bool isAc3d)
	{
		if (!Directory.Exists(inputPath))
		{
			Logger.Error($"Input path does not exist: {inputPath}");
			return;
		}

		string[] allBglFiles = Directory.GetFiles(inputPath, "*.bgl", new EnumerationOptions
		{
			MatchCasing = MatchCasing.CaseInsensitive,
			RecurseSubdirectories = true,
			ReturnSpecialDirectories = false
		});
		int totalLibraryObjects = 0;
		// Gather placements and airports first
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

			List<int> sceneryObjectOffsets = [];
			List<int> airportOffsets = [];
			for (int i = 0; i < recordCt; i++)
			{
				long recordStartPos = br.BaseStream.Position;
				uint recType = br.ReadUInt32();
				_ = br.BaseStream.Seek(recordStartPos + 0x08, SeekOrigin.Begin);
				int subrecordCount = (int)br.ReadUInt32();
				uint startSubsection = br.ReadUInt32();
				uint recSize = br.ReadUInt32();
				if (recType == 0x0025) // SceneryObject
				{
					for (int j = 0; j < subrecordCount; j++)
					{
						sceneryObjectOffsets.Add((int)startSubsection + (j * 16));
					}
				}
				else if (recType == 0x0003) // Airport
				{
					for (int j = 0; j < subrecordCount; j++)
					{
						airportOffsets.Add((int)startSubsection + (j * 16));
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

			foreach ((int subOffset, int subSize) in sceneryObjectSubrecords)
			{
				int bytesRead = 0;
				while (bytesRead < subSize)
				{
					_ = br.BaseStream.Seek(subOffset + bytesRead, SeekOrigin.Begin);
					ushort id = br.ReadUInt16();
					uint size = br.ReadUInt16();
					if (id == 0x0B) // LibraryObject
					{
						_ = br.BaseStream.Seek(-4, SeekOrigin.Current); // Reverse back to get all of the bytes
						LibraryObject libObj = BuildLibraryObject(br.ReadBytes((int)size));
						if (!libraryObjects.TryGetValue(libObj.guid, out _))
						{
							libraryObjects[libObj.guid] = [];
						}
						libraryObjects[libObj.guid].Add(libObj);
					}
					else if (id == 0x19) // SimObject
					{
						_ = br.BaseStream.Seek(-4, SeekOrigin.Current); // Reverse back to get all of the bytes
						BuildSimObject(br.ReadBytes((int)size));
					}
					else
					{
						Logger.Warning($"Unexpected subrecord type at offset 0x{subOffset + bytesRead:X}: 0x{id:X4}, skipping {size} bytes");
						_ = br.BaseStream.Seek(subOffset + size, SeekOrigin.Begin);
						bytesRead += (int)size;
						continue;
					}
					totalLibraryObjects++;
					Status = $"Looking for placements in {Path.GetFileName(file)}... found {totalLibraryObjects}";
					bytesRead += (int)size;
				}
			}

			// Parse Airport subrecords
			List<(int offset, int size)> airportSubrecords = [];
			foreach (int airportOffset in airportOffsets)
			{
				_ = br.BaseStream.Seek(airportOffset + 8, SeekOrigin.Begin);
				int subrecOffset = (int)br.ReadUInt32();
				int size = (int)br.ReadUInt32();
				airportSubrecords.Add((subrecOffset, size));
			}

			foreach ((int subOffset, int subSize) in airportSubrecords)
			{
				int bytesRead = 0;
				while (bytesRead < subSize)
				{
					_ = br.BaseStream.Seek(subOffset + bytesRead, SeekOrigin.Begin);
					ushort id = br.ReadUInt16();
					if (id != 0x0056) // Airport
					{
						uint skip = br.ReadUInt32();
						Logger.Warning($"Unexpected airport subrecord type at offset 0x{subOffset + bytesRead:X}: 0x{id:X4}, skipping {skip} bytes");
						_ = br.BaseStream.Seek(subOffset + skip, SeekOrigin.Begin);
						bytesRead += (int)skip;
						continue;
					}
					Airport airport = new();
					uint size = br.ReadUInt32();
					int runwayCt = br.ReadByte();
					int comCt = br.ReadByte();
					int startCt = br.ReadByte();
					int appCt = br.ReadByte();
					int legacyApronCt = br.ReadByte();
					int helipadCt = br.ReadByte();
					airport.longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0;
					airport.latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0));
					airport.altitude = br.ReadInt32() / 1000.0;
					airport.tower = new()
					{
						latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0)),
						longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0,
						altitude = br.ReadInt32() / 1000.0
					};
					airport.magvar = br.ReadSingle();
					airport.icao = ConvertIcaoBytesToString(br.ReadInt32());
					airport.regIdent = ConvertIcaoBytesToString(br.ReadInt32() & 0x3FF);
					airport.runways = [];
					airport.runwayStarts = [];
					airport.taxiwayPoints = [];
					airport.taxiwayParkings = [];
					airport.taxiwayPaths = [];
					airport.taxiNames = [];
					airport.aprons = [];
					airport.taxiwaySigns = [];
					airport.paintedLines = [];
					airport.paintedHatchedAreas = [];
					airport.jetways = [];
					airport.lightSupports = [];
					airport.approaches = [];
					airport.apronEdgeLights = [];
					airport.helipads = [];

					br.BaseStream.Seek(subOffset + bytesRead + 0x37, SeekOrigin.Begin); // Skip ahead to departure count
					int departureCt = br.ReadByte();
					br.BaseStream.Seek(subOffset + bytesRead + 0x39, SeekOrigin.Begin); // Skip ahead to arrival count
					int arrivalCt = br.ReadByte();
					br.BaseStream.Seek(subOffset + bytesRead + 0x3c, SeekOrigin.Begin); // Skip ahead to remaining useful records
					ushort apronCt = br.ReadUInt16();
					ushort paintedLineCt = br.ReadUInt16();
					ushort paintedPolygonCt = br.ReadUInt16();
					ushort paintedHatchedAreaCt = br.ReadUInt16();
					Console.WriteLine($"stream position before airport records: 0x{br.BaseStream.Position:X}");
					uint airportBytesRead = 0x44; // Start with 0x44 bytes we've already read

					while (airportBytesRead < size)
					{
						// This shouldn't be necessary, but it puts you back on the straight and narrow if something goes wrong in the parsing and we get off-track
						_ = br.BaseStream.Seek(subOffset + bytesRead + airportBytesRead, SeekOrigin.Begin);

						ushort recordId = br.ReadUInt16();
						uint recordSize = br.ReadUInt32();
						if (recordId == 0x0019) // Airport Name
						{
							airport.name = Encoding.UTF8.GetString(br.ReadBytes((int)recordSize - 6));
						}
						else if (recordId == 0x00ce) // Runway
						{
							br.BaseStream.Seek(2, SeekOrigin.Current); // Skip not-useful data
							Runway runway = new()
							{
								primaryNumber = br.ReadByte(),
								primaryDesignator = (Designator)br.ReadByte(),
								secondaryNumber = br.ReadByte(),
								secondaryDesignator = (Designator)br.ReadByte(),
								primaryILSIdent = ConvertIcaoBytesToString(br.ReadInt32()),
								secondaryILSIdent = ConvertIcaoBytesToString(br.ReadInt32()),
								longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0,
								latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0)),
								altitude = br.ReadInt32() / 1000.0,
								length = br.ReadUInt32() / 1000.0,
								width = br.ReadUInt32() / 1000.0,
								heading = Math.Round(br.ReadSingle() * (360.0 / 65536.0), 3),
								patternAltitude = br.ReadSingle() / 1000.0,
								markingTypes = [],
								lightTypes = [],
								patternTypes = [],
								vasis = [],
								offsetThresholds = [],
								blastPads = [],
								overruns = [],
								approachLights = [],
							};
							short markingValue = br.ReadInt16();
							byte lightValue = br.ReadByte();
							byte patternValue = br.ReadByte();
							List<RunwayMarkingType> markingTypes = [];
							List<RunwayLightType> lightTypes = [];
							List<RunwayPatternType> patternTypes = [];

							for (int j = 0; j < 16; j++)
							{
								if (((markingValue >> j) & 1) != 0)
								{
									markingTypes.Add((RunwayMarkingType)j);
								}
							}

							if ((lightValue & (1 << 5)) != 0)
							{
								markingTypes.Add(RunwayMarkingType.AltPrecision);
							}
							if ((lightValue & (1 << 6)) != 0)
							{
								markingTypes.Add(RunwayMarkingType.LeadingZeroIdent);
							}
							if ((lightValue & (1 << 7)) != 0)
							{
								markingTypes.Add(RunwayMarkingType.NoThresholdEndArrows);
							}

							int edgeLightsValue = lightValue & 0b11;
							lightTypes.Add((RunwayLightType)edgeLightsValue);

							int centerLightsValue = (lightValue >> 2) & 0b11;
							lightTypes.Add((RunwayLightType)(4 + centerLightsValue));

							if ((lightValue & (1 << 4)) != 0)
							{
								lightTypes.Add(RunwayLightType.CenterRed);
							}

							if ((patternValue & (1 << 0)) != 0)
							{
								patternTypes.Add(RunwayPatternType.PrimaryTakeoff);
							}
							if ((patternValue & (1 << 1)) != 0)
							{
								patternTypes.Add(RunwayPatternType.PrimaryLanding);
							}
							if ((patternValue & (1 << 2)) != 0)
							{
								patternTypes.Add(RunwayPatternType.PrimaryPattern);
							}
							if ((patternValue & (1 << 3)) != 0)
							{
								patternTypes.Add(RunwayPatternType.SecondaryTakeoff);
							}
							if ((patternValue & (1 << 4)) != 0)
							{
								patternTypes.Add(RunwayPatternType.SecondaryLanding);
							}
							if ((patternValue & (1 << 5)) != 0)
							{
								patternTypes.Add(RunwayPatternType.SecondaryPattern);
							}

							runway.markingTypes = [.. markingTypes];
							runway.lightTypes = [.. lightTypes];
							runway.patternTypes = [.. patternTypes];
							runway.groundMerging = (patternValue & (1 << 6)) != 0;
							runway.excludeVegetationAround = (patternValue & (1 << 7)) != 0;
							br.BaseStream.Seek(0x14, SeekOrigin.Current);
							runway.falloff = br.ReadSingle();
							runway.surface = new(br.ReadBytes(16));
							runway.coloration = [br.ReadByte(), br.ReadByte(), br.ReadByte(), br.ReadByte()];
							uint runwayBytesRead = 0x60;
							while (runwayBytesRead < recordSize)
							{
								br.BaseStream.Seek(subOffset + bytesRead + airportBytesRead + runwayBytesRead, SeekOrigin.Begin);
								ushort runwayRecordId = br.ReadUInt16();
								uint runwayRecordSize = br.ReadUInt32();
								if (runwayRecordId >= 0x000b && runwayRecordId <= 0x000e) // VASI
								{
									runway.vasis.Add(new Vasi
									{
										childType = (VasiChildType)(runwayRecordId - 0x000b),
										type = (VasiType)(runwayRecordId - 0x000b),
										biasX = br.ReadSingle(),
										biasZ = br.ReadSingle(),
										spacing = br.ReadSingle(),
										pitch = br.ReadSingle(),
									});
								}
								else if (runwayRecordId == 0x0005) // OffsetThreshold
								{
									runway.offsetThresholds.Add(new OffsetThreshold
									{
										fsXSurface = (Surface)br.ReadSingle(),
										surface = new(br.ReadBytes(16)),
										length = br.ReadSingle(),
										width = br.ReadSingle(),
									});
								}
								else if (runwayRecordId == 0x0007 || runwayRecordId == 0x0008) // BlastPad
								{
									runway.blastPads.Add(new BlastPad
									{
										fsXSurface = (Surface)br.ReadSingle(),
										surface = new(br.ReadBytes(16)),
										length = br.ReadSingle(),
										width = br.ReadSingle(),
									});
								}
								else if (runwayRecordId == 0x0065 || runwayRecordId == 0x0066) // Overrun
								{
									runway.overruns.Add(new Overrun
									{
										fsXSurface = (Surface)br.ReadSingle(),
										surface = new(br.ReadBytes(16)),
										length = br.ReadSingle(),
										width = br.ReadSingle(),
									});
								}
								else if (runwayRecordId == 0x00df || runwayRecordId == 0x00e0) // ApproachLights
								{
									byte typeValue = br.ReadByte();
									runway.approachLights.Add(new ApproachLight
									{
										type = (ApproachLightType)(typeValue & 0b1111),
										endLights = (typeValue & 0b10000) != 0,
										reil = (typeValue & 0b100000) != 0,
										touchdown = (typeValue & 0b1000000) != 0,
										strobes = br.ReadByte(),
										spacing = br.ReadSingle(),
										offset = br.ReadSingle(),
										slope = br.ReadSingle(),
									});
									br.BaseStream.Seek(4, SeekOrigin.Current); // Skip unknown field
								}
								else if (runwayRecordId == 0x00cb) // FacilityMaterial
								{
									br.BaseStream.Seek(1, SeekOrigin.Current); // Skip unknown field
									runway.facilityMaterial = new FacilityMaterial
									{
										opacity = br.ReadByte(),
										guid = new(br.ReadBytes(16))
									};
									br.BaseStream.Seek(4, SeekOrigin.Current); // Skip another unknown field
									runway.facilityMaterial.tilingU = br.ReadSingle();
									runway.facilityMaterial.tilingV = br.ReadSingle();
									runway.facilityMaterial.width = br.ReadSingle();
									runway.facilityMaterial.falloff = br.ReadSingle();
								}
								runwayBytesRead += runwayRecordSize;
							}
							airport.runways.Add(runway);
						}
						else if (recordId == 0x0011) // Start
						{
							RunwayStart runwayStart = new()
							{
								runwayNumber = br.ReadByte(),
							};
							byte value = br.ReadByte();
							runwayStart.designator = (Designator)(value & 0b1111);
							runwayStart.type = (RunwayStartType)((value >> 4) & 0b1111);
							runwayStart.longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0;
							runwayStart.latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0));
							runwayStart.altitude = br.ReadInt32() / 1000.0;
							runwayStart.heading = br.ReadSingle() * (360.0 / 65536.0);
							airport.runwayStarts.Add(runwayStart);
						}
						else if (recordId == 0x001a) // TaxiwayPoint
						{
							ushort subRecordCount = br.ReadUInt16();
							for (int j = 0; j < subRecordCount; j++)
							{
								TaxiwayPoint taxiwayPoint = new()
								{
									type = (TaxiPointType)br.ReadByte(),
									orientation = (TaxiPointOrientation)br.ReadByte(),
								};
								br.BaseStream.Seek(2, SeekOrigin.Current); // Skip unknown field
								taxiwayPoint.longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0;
								taxiwayPoint.latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0));
								airport.taxiwayPoints.Add(taxiwayPoint);
							}
						}
						else if (recordId == 0x00e7) // TaxiwayParking
						{
							ushort subRecordCount = br.ReadUInt16();
							for (int j = 0; j < subRecordCount; j++)
							{
								int value = br.ReadInt32();
								TaxiwayParking taxiwayParking = new()
								{
									name = (ParkingName)(value & 0b111111),
									pushback = (ParkingPushback)((value >> 6) & 0b11),
									type = (ParkingType)((value >> 8) & 0b1111),
									number = (uint)((value >> 12) & 0xFFF),
									airlineCodes = new string[value >> 24 & 0xFF],
									radius = br.ReadSingle(),
									heading = br.ReadSingle() * (360.0 / 65536.0),
									teeOffset1 = br.ReadSingle(),
									teeOffset2 = br.ReadSingle(),
									teeOffset3 = br.ReadSingle(),
									teeOffset4 = br.ReadSingle(),
									longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0,
									latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0))
								};
								for (int k = 0; k < taxiwayParking.airlineCodes.Length; k++)
								{
									taxiwayParking.airlineCodes[k] = Encoding.ASCII.GetString(br.ReadBytes(4));
								}
								taxiwayParking.numberMarking = br.ReadBoolean();
								taxiwayParking.suffix = (ParkingName)br.ReadByte();
								br.BaseStream.Seek(5, SeekOrigin.Current); // Skip unknown fields
								taxiwayParking.numberBiasX = br.ReadSingle();
								taxiwayParking.numberBiasZ = br.ReadSingle();
								taxiwayParking.numberHeading = br.ReadSingle() * (360.0 / 65536.0);
								airport.taxiwayParkings.Add(taxiwayParking);
							}
						}
						else if (recordId == 0x00d4) // TaxiwayPath
						{
							ushort subRecordCount = br.ReadUInt16();
							for (int j = 0; j < subRecordCount; j++)
							{
								TaxiwayPath taxiwayPath = new()
								{
									start = br.ReadUInt16()
								};
								short value1 = br.ReadInt16();
								byte value2 = br.ReadByte();
								taxiwayPath.legacyEnd = (ushort)(value1 & 0x7FF);
								taxiwayPath.designator = (Designator)((value1 >> 11) & 0b1111);
								taxiwayPath.type = (TaxiwayPathType)(value2 & 0b111);
								taxiwayPath.enhanced = (value2 & 0b1000) == 1;
								taxiwayPath.drawSurface = (value2 & 0b10000) == 1;
								taxiwayPath.drawDetail = (value2 & 0b100000) == 1;
								if (taxiwayPath.type == TaxiwayPathType.Runway)
								{
									taxiwayPath.runwayNumber = br.ReadByte();
								}
								else
								{
									taxiwayPath.name = br.ReadByte();
								}
								byte value3 = br.ReadByte();
								taxiwayPath.centerLine = (value3 & 0b1) == 1;
								taxiwayPath.centerLineLighted = (value3 & 0b10) == 1;
								taxiwayPath.leftEdge = (TaxiwayEdgeType)(value3 & 0b1100);
								taxiwayPath.leftEdgeLighted = (value3 & 0b10000) == 1;
								taxiwayPath.rightEdge = (TaxiwayEdgeType)(value3 & 0b1100000);
								taxiwayPath.rightEdgeLighted = (value3 & 0b10000000) == 1;
								taxiwayPath.fsXSurface = (Surface)br.ReadByte();
								taxiwayPath.width = br.ReadSingle();
								taxiwayPath.weightLimit = br.ReadUInt32();
								br.BaseStream.Seek(8, SeekOrigin.Current); // Skip unknown field
								taxiwayPath.surface = new(br.ReadBytes(16));
								taxiwayPath.coloration = [br.ReadByte(), br.ReadByte(), br.ReadByte(), br.ReadByte()];
								int materialCt = br.ReadByte();
								byte value4 = br.ReadByte();
								taxiwayPath.groundMerging = (value4 & 0b1) == 1;
								taxiwayPath.excludeVegetationAround = (value4 & 0b10) == 0;
								taxiwayPath.excludeVegetationInside = (value4 & 0b100) == 0;
								taxiwayPath.end = br.ReadUInt16();
								taxiwayPath.materials = [];
								for (int k = 0; k < materialCt; k++)
								{
									if (br.ReadInt16() == 0x00d5) // TaxiwayPathMaterial
									{
										_ = br.BaseStream.Seek(4, SeekOrigin.Current); // The record size, but it's the same every time
										taxiwayPath.materials.Add(new TaxiwayPathMaterial
										{
											type = br.ReadByte(),
											opacity = br.ReadByte(),
											surface = new(br.ReadBytes(16)),
											materialType = (TaxiwayPathMaterialType)br.ReadUInt32(),
											tilingU = br.ReadSingle(),
											tilingV = br.ReadSingle(),
											width = br.ReadSingle(),
											falloff = br.ReadSingle()
										});
									}
								}
								airport.taxiwayPaths.Add(taxiwayPath);
							}
						}
						else if (recordId == 0x001d) // TaxiName
						{
							ushort subRecordCount = br.ReadUInt16();
							for (int j = 0; j < subRecordCount; j++)
							{
								airport.taxiNames.Add(Encoding.UTF8.GetString(br.ReadBytes(8)));
							}
						}
						else if (recordId == 0x00d3) // Apron
						{
							byte value = br.ReadByte();
							Apron apron = new()
							{
								drawSurface = (value & 0b1) == 1,
								drawDetail = (value & 0b10) == 1,
								localUV = (value & 0b100) == 1,
								stretchUV = (value & 0b1000) == 1,
								groundMerging = (value & 0b10000) == 0,
								excludeVegetationAround = (value & 0b100000) == 0,
								excludeVegetationInside = (value & 0b1000000) == 0,
								opacity = br.ReadByte(),
								coloration = [br.ReadByte(), br.ReadByte(), br.ReadByte(), br.ReadByte()],
								surface = new(br.ReadBytes(16)),
								tiling = br.ReadSingle(),
								heading = br.ReadSingle() * (360.0 / 65536.0),
								falloff = br.ReadSingle(),
								priority = br.ReadInt32(),
								vertices = [],
								tris = []
							};
							ushort vertexCt = br.ReadUInt16();
							ushort triangleCt = br.ReadUInt16();
							for (int j = 0; j < vertexCt; j++)
							{
								apron.vertices.Add(new Vector2
									((float)(((float)(br.ReadUInt32() * (360.0 / 805306368.0))) - 180.0),
									(float)(90.0 - (br.ReadUInt32() * (180.0 / 536870912.0))))
								);
							}
							for (int j = 0; j < triangleCt; j++)
							{
								apron.tris.Add(new Vector3(br.ReadUInt16(), br.ReadUInt16(), br.ReadUInt16()));
							}
							airport.aprons.Add(apron);
						}
						else if (recordId == 0x00d9) // TaxiwaySign
						{
							_ = br.BaseStream.Seek(2, SeekOrigin.Current); // Skip record size, it's always the same
							airport.taxiwaySigns.Add(new TaxiwaySign
							{
								longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0,
								latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0)),
								heading = br.ReadSingle() * (360.0 / 65536.0),
								size = br.ReadByte(),
								justificationRight = (br.ReadByte() & 0b1) == 1,
								label = Encoding.ASCII.GetString(br.ReadBytes(0x3e)),
							});
						}
						else if (recordId == 0x00cf) // PaintedLine
						{
							PaintedLine paintedLine = new()
							{
								type = (PaintedLineType)br.ReadByte(),
								trueAngle = (PaintedLineTrueAngle)br.ReadByte(),
								vertices = []
							};
							uint vertexCt = br.ReadUInt32();
							paintedLine.surface = new(br.ReadBytes(16));
							for (int j = 0; j < vertexCt; j++)
							{
								paintedLine.vertices.Add(new Vector2
									((float)(((float)(br.ReadUInt32() * (360.0 / 805306368.0))) - 180.0),
									(float)(90.0 - (br.ReadUInt32() * (180.0 / 536870912.0))))
								);
							}
							airport.paintedLines.Add(paintedLine);
						}
						else if (recordId == 0x00d8) // PaintedHatchedArea
						{
							PaintedHatchedArea paintedHatchedArea = new()
							{
								type = (PaintedLineType)br.ReadByte(),
								vertices = []
							};
							ushort vertexCt = br.ReadUInt16();
							paintedHatchedArea.heading = br.ReadSingle() * (360.0 / 65536.0);
							paintedHatchedArea.spacing = br.ReadSingle();
							for (int j = 0; j < vertexCt; j++)
							{
								paintedHatchedArea.vertices.Add(new Vector2
									((float)(((float)(br.ReadUInt32() * (360.0 / 805306368.0))) - 180.0),
									(float)(90.0 - (br.ReadUInt32() * (180.0 / 536870912.0))))
								);
							}
							airport.paintedHatchedAreas.Add(paintedHatchedArea);
						}
						else if (recordId == 0x00de) // Jetway
						{
							airport.jetways.Add(new Jetway()
							{
								parkingNumber = br.ReadUInt16(),
								gateName = (ParkingName)br.ReadUInt16(),
								suffix = (ParkingName)br.ReadUInt16(),
							});
							_ = br.BaseStream.Seek(2, SeekOrigin.Current); // Skip unknown field
							ushort sceneryObjectLength1 = br.ReadUInt16();
							ushort sceneryObjectLength2 = br.ReadUInt16();
							if (sceneryObjectLength1 > 0)
							{
								byte[] sceneryObjectBytes = br.ReadBytes(sceneryObjectLength1);
								if (BitConverter.ToInt16(sceneryObjectBytes, 0) == 0x000b)
								{
									LibraryObject libObj = BuildLibraryObject(sceneryObjectBytes);
									if (libraryObjects.TryGetValue(libObj.guid, out List<LibraryObject>? libObjList))
									{
										libObjList.Add(libObj);
									}
									else
									{
										libraryObjects[libObj.guid] = [libObj];
									}
								}
								else if (BitConverter.ToInt16(sceneryObjectBytes, 0) == 0x0019)
								{
									BuildSimObject(sceneryObjectBytes);
								}
								else
								{
									Logger.Warning($"Unexpected scenery object type in jetway record at offset 0x{subOffset + bytesRead + airportBytesRead:X}: 0x{BitConverter.ToInt16(sceneryObjectBytes, 0):X4}");
								}
							}
							if (sceneryObjectLength2 > 0)
							{
								byte[] sceneryObjectBytes = br.ReadBytes(sceneryObjectLength2);
								if (BitConverter.ToInt16(sceneryObjectBytes, 0) == 0x000b)
								{
									LibraryObject libObj = BuildLibraryObject(sceneryObjectBytes);
									if (libraryObjects.TryGetValue(libObj.guid, out List<LibraryObject>? libObjList))
									{
										libObjList.Add(libObj);
									}
									else
									{
										libraryObjects[libObj.guid] = [libObj];
									}
								}
								else if (BitConverter.ToInt16(sceneryObjectBytes, 0) == 0x0019)
								{
									BuildSimObject(sceneryObjectBytes);
								}
								else
								{
									Logger.Warning($"Unexpected scenery object type in jetway record at offset 0x{subOffset + bytesRead + airportBytesRead:X}: 0x{BitConverter.ToInt16(sceneryObjectBytes, 0):X4}");
								}
							}
						}
						else if (recordId == 0x0057) // LightSupport
						{
							_ = br.BaseStream.Seek(2, SeekOrigin.Current); // Skip unknown field
							airport.lightSupports.Add(new LightSupport
							{
								latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0)),
								longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0,
								altitude = br.ReadInt32() / 1000.0,
								altitude2 = br.ReadInt32() / 1000.0,
								heading = br.ReadSingle() * (360.0 / 65536.0),
								width = br.ReadSingle(),
								length = br.ReadSingle()
							});
						}
						else if (recordId == 0x0024) // Approach
						{
							// This is taking a lot of time, and my current structure doesn't lend itself to it very much at all
							// Comment this out, return to it some other day, and skip the records in the meantime
							_ = br.BaseStream.Seek(recordSize, SeekOrigin.Current);
							/* Approach approach = new()
							{
								suffix = br.ReadChar(),
								runwayNumber = br.ReadByte(),
							};
							byte value1 = br.ReadByte();
							approach.type = (ApproachType)(value1 & 0b1111);
							approach.designator = (Designator)((value1 >> 4) & 0b111);
							approach.gpsOverlay = (value1 & 0b10000000) == 1;
							int transitionCount = br.ReadByte();
							int legCount = br.ReadByte();
							int missedApproachCount = br.ReadByte();
							approach.fixType = (FixType)(br.ReadByte() & 0b11111);
							approach.fixIdent = ConvertIcaoBytesToString(br.ReadInt32());
							int value2 = br.ReadInt32();
							approach.fixRegion = ConvertIcaoBytesToString(value2 & 0x7FF);
							approach.airportIdent = ConvertIcaoBytesToString((int)(value2 & 0xFFFFF800));
							approach.altitude = br.ReadInt32() / 1000.0;
							approach.heading = br.ReadSingle() * (360.0 / 65536.0);
							approach.missedAltitude = br.ReadInt32() / 1000.0;
							approach.approachLegs = [];
							approach.transitionLegs = [];
							approach.missedApproachLegs = [];
							int airportRecordBytesRead = 0x20;
							while (airportRecordBytesRead < recordSize)
							{
								ushort approachRecordId = br.ReadUInt16();
								uint approachRecordSize = br.ReadUInt32();
								if (approachRecordId >= 0x00e1 && approachRecordId <= 0x00e6)
								{
									ushort legCt = br.ReadUInt16();
									for (int j = 0; j < legCt; j++)
									{
										Leg leg = new()
										{
											type = (LegType)br.ReadByte(),
											altitudeDescriptor = (AltitudeDescriptor)br.ReadByte()
										};
										int value3 = br.ReadInt16();
										leg.turnDirection = (TurnDirection)(value3 & 0b11);
										leg.courseIsTrue = (value3 & 0x100) == 1;
										leg.timeIsSpecified = (value3 & 0x200) == 1;
										leg.flyOver = (value3 & 0x400) == 1;
										int value4 = br.ReadInt32();
										leg.fixType = (FixType)(value4 & 0b11111);
										leg.fixIdent = ConvertIcaoBytesToString(value4);
										int value5 = br.ReadInt32();
										leg.fixRegion = ConvertIcaoBytesToString(value5 & 0x7FF);
										leg.fixAirport = ConvertIcaoBytesToString((int)(value5 & 0xFFFFF800));
										int value6 = br.ReadInt32();
										leg.recommendedType = (FixType)(value6 & 0b1111);
										leg.recommendedIdent = ConvertIcaoBytesToString(value6);
										int value7 = br.ReadInt32();
										leg.recommendedRegion = ConvertIcaoBytesToString(value7 & 0x7FF);
										leg.recommendedAirport = ConvertIcaoBytesToString((int)(value7 & 0xFFFFF800));
										leg.theta = br.ReadSingle() * (360.0 / 65536.0);
										leg.rho = br.ReadSingle();
										if (leg.courseIsTrue)
										{
											leg.trueCourse = br.ReadSingle() * (360.0 / 65536.0);
										}
										else
										{
											leg.magneticCourse = br.ReadSingle() * (360.0 / 65536.0);
										}

										if (leg.timeIsSpecified)
										{
											leg.time = br.ReadSingle();
										}
										else
										{
											leg.distance = br.ReadSingle();
										}
										leg.altitude1 = br.ReadInt32() / 1000.0;
										leg.altitude2 = br.ReadInt32() / 1000.0;
										leg.speedLimit = br.ReadSingle();
										leg.verticalAngle = br.ReadSingle();
										_ = br.BaseStream.Seek(16, SeekOrigin.Current); // Skip unknown field
										if (approachRecordId == 0x00e2)
										{
											approach.missedApproachLegs.Add(leg);
										}
										else if (approachRecordId == 0x00e3)
										{
											approach.transitionLegs.Add(leg);
										}
										else
										{
											approach.approachLegs.Add(leg);
										}
									}
								}
								else if (approachRecordId == 0x002c
										|| approachRecordId == 0x0046
										|| approachRecordId == 0x0047
										|| approachRecordId == 0x004a)
								{
									int transitionLegsCount = br.ReadByte();
									int number;
									Designator designator;
									if (approachRecordId == 0x0046)
									{
										number = br.ReadByte();
										designator = (Designator)br.ReadByte();
										br.BaseStream.Seek(3, SeekOrigin.Current); // Skip unknown field
									}
									for (int j = 0; j < transitionLegsCount; j++)
									{
										TransitionLeg transitionLeg = new()
										{
											type = (LegType)br.ReadByte(),
											altitudeDescriptor = (AltitudeDescriptor)br.ReadByte()
										};
										int value3 = br.ReadInt16();
										transitionLeg.turnDirection = (TurnDirection)(value3 & 0b11);
										transitionLeg.courseIsTrue = (value3 & 0x100) == 1;
										transitionLeg.timeIsSpecified = (value3 & 0x200) == 1;
										transitionLeg.flyOver = (value3 & 0x400) == 1;
										int value4 = br.ReadInt32();
										transitionLeg.fixType = (FixType)(value4 & 0b11111);
										transitionLeg.fixIdent = ConvertIcaoBytesToString(value4);
										int value5 = br.ReadInt32();
										transitionLeg.fixRegion = ConvertIcaoBytesToString(value5 & 0x7FF);
										transitionLeg.fixAirport = ConvertIcaoBytesToString((int)(value5 & 0xFFFFF800));
										int value6 = br.ReadInt32();
										transitionLeg.recommendedType = (FixType)(value6 & 0b1111);
										transitionLeg.recommendedIdent = ConvertIcaoBytesToString(value6);
										int value7 = br.ReadInt32();
										transitionLeg.recommendedRegion = ConvertIcaoBytesToString(value7 & 0x7FF);
										transitionLeg.recommendedAirport = ConvertIcaoBytesToString((int)(value7 & 0xFFFFF800));
										transitionLeg.theta = br.ReadSingle() * (360.0 / 65536.0);
										transitionLeg.rho = br.ReadSingle();
										if (transitionLeg.courseIsTrue)
										{
											transitionLeg.trueCourse = br.ReadSingle() * (360.0 / 65536.0);
										}
										else
										{
											transitionLeg.magneticCourse = br.ReadSingle() * (360.0 / 65536.0);
										}

										if (transitionLeg.timeIsSpecified)
										{
											transitionLeg.time = br.ReadSingle();
										}
										else
										{
											transitionLeg.distance = br.ReadSingle();
									}
								}
							} */
						}
						else if (recordId == 0x0031) // ApronEdgeLights
						{
							_ = br.BaseStream.Seek(2, SeekOrigin.Current); // Skip unknown record
							ushort vertexCt = br.ReadUInt16();
							ushort edgeCt = br.ReadUInt16();
							ApronEdgeLights apronEdgeLights = new()
							{
								coloration = [br.ReadByte(), br.ReadByte(), br.ReadByte(), br.ReadByte()],
								scale = br.ReadSingle(),
								falloff = br.ReadSingle(),
								vertices = [],
								edges = []
							};
							for (int j = 0; j < vertexCt; j++)
							{
								apronEdgeLights.vertices.Add(new Vector2
									((float)(((float)(br.ReadUInt32() * (360.0 / 805306368.0))) - 180.0),
									(float)(90.0 - (br.ReadUInt32() * (180.0 / 536870912.0))))
								);
							}
							for (int j = 0; j < edgeCt; j++)
							{
								apronEdgeLights.edges.Add(new Vector3(br.ReadSingle(), br.ReadUInt16(), br.ReadUInt16()));
							}
							airport.apronEdgeLights.Add(apronEdgeLights);
						}
						else if (recordId == 0x0026) // Helipad
						{
							Helipad helipad = new()
							{
								surface = (Surface)br.ReadByte()
							};
							byte value = br.ReadByte();
							helipad.type = (HelipadType)(value & 0b1111);
							helipad.transparent = (value & 0b10000) == 1;
							helipad.closed = (value & 0b100000) == 1;
							helipad.color = [br.ReadByte(), br.ReadByte(), br.ReadByte(), br.ReadByte()];
							helipad.longitude = (br.ReadUInt32() * (360.0 / 805306368.0)) - 180.0;
							helipad.latitude = 90.0 - (br.ReadUInt32() * (180.0 / 536870912.0));
							helipad.altitude = br.ReadInt32() / 1000.0;
							helipad.length = br.ReadSingle();
							helipad.width = br.ReadSingle();
							helipad.heading = br.ReadSingle() * (360.0 / 65536.0);
							airport.helipads.Add(helipad);
						}
						else if (recordId == 0x00e8) // ProjectedMesh
						{
							ProjectedMesh projectedMesh = new()
							{
								priority = br.ReadByte()
							};
							_ = br.BaseStream.Seek(1, SeekOrigin.Current); // Skip unknown field
							int value = br.ReadInt32();
							projectedMesh.groundMerging = (value & 0b1) == 1;
							ushort subRecordSize = br.ReadUInt16();
							byte[] sceneryObjectBytes = br.ReadBytes(subRecordSize);
							if (BitConverter.ToInt16(sceneryObjectBytes, 0) == 0x000b)
							{
								projectedMesh.libraryObject = BuildLibraryObject(sceneryObjectBytes);
							}
						}
						else
						{
							Logger.Warning($"Unexpected airport record type at offset 0x{subOffset + bytesRead + airportBytesRead:X}: 0x{recordId:X4}, skipping {recordSize} bytes");
						}
						airportBytesRead += recordSize;
					}
					airports.Add(airport);
					bytesRead += (int)size;
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
		totalModelCount = modelReferencesByTile.Values.Sum(l => l.Count);
		if (isGltf && isAc3d) totalModelCount *= 2;
		Logger.Info($"Found {totalModelCount} models");
		if (totalModelCount == 0)
		{
			Status = "No models found to convert.";
			return;
		}

		foreach (var kvp in modelReferencesByTile)
		{
			int tileIndex = kvp.Key;
			List<ModelReference> modelRefs = [.. kvp.Value.OrderByDescending(mr => mr.size)];
			Logger.Info($"Tile {tileIndex} has {modelRefs.Count} model references");
			List<LibraryObject> libraryObjectsForTile = [.. libraryObjects.Values.SelectMany(loList => loList).Where(lo => Terrain.GetTileIndex(lo.latitude, lo.longitude) == tileIndex)];
			Vector3 center = new(
				(float)(libraryObjectsForTile.Count > 0 ? libraryObjectsForTile.Sum(lo => lo.latitude) / libraryObjectsForTile.Count : 0.0),
				(float)(libraryObjectsForTile.Count > 0 ? libraryObjectsForTile.Sum(lo => lo.longitude) / libraryObjectsForTile.Count : 0.0),
				(float)(libraryObjectsForTile.Count > 0 ? libraryObjectsForTile.Sum(lo => lo.altitude) / libraryObjectsForTile.Count : 0.0)
			);
			SceneBuilder tileSceneGltf = new();
			AcBuilder tileSceneAc = new();
			if (isGltf)
			{
				tileSceneGltf = ConvertSceneryGltf(inputPath, outputPath, kvp, center);
			}
			if (isAc3d)
			{
				tileSceneAc = ConvertSceneryAc3d(inputPath, outputPath, kvp, center);
			}
			(double lat, double lon) = Terrain.GetLatLon(tileIndex);
			string lonHemi = lon >= 0 ? "e" : "w";
			string latHemi = lat >= 0 ? "n" : "s";
			string path = $"{outputPath}/Objects/{lonHemi}{Math.Abs(Math.Floor(lon / 10)) * 10:000}{latHemi}{Math.Abs(Math.Floor(lat / 10)) * 10:00}/{lonHemi}{Math.Abs(Math.Floor(lon)):000}{latHemi}{Math.Abs(Math.Floor(lat)):00}";
			if (!Directory.Exists(path))
			{
				_ = Directory.CreateDirectory(path);
			}

			if (isAc3d)
			{
				string outAcPath = Path.Combine(path, $"{tileIndex}.ac");
				if (tileSceneAc.Objects.Count == 0)
				{
					Logger.Info($"Tile {tileIndex} produced no geometry for AC3D export; skipping file generation.");
				}
				else
				{
					Status = "Saving model to disk...";
					tileSceneAc.WriteToFile(outAcPath);
				}
			}

			if (isGltf)
			{
				string outGlbPath = Path.Combine(path, $"{tileIndex}.gltf");
				Status = "Saving model to disk...";
				tileSceneGltf.ToGltf2().SaveGLTF(outGlbPath, new WriteSettings
				{
					ImageWriting = ResourceWriteMode.SatelliteFile,
					// This name doesn't matter; we will fix up the URIs in the postprocessor
					ImageWriteCallback = (context, assetName, image) => { return ""; },
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
								if (!File.Exists(Path.Combine(path, Path.GetFileName(baseColorTex))))
									File.Copy(baseColorTex, Path.Combine(path, Path.GetFileName(baseColorTex)));
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
								if (!File.Exists(Path.Combine(path, Path.GetFileName(metallicRoughnessTex))))
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
								if (!File.Exists(Path.Combine(path, Path.GetFileName(normaTex))))
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
								if (!File.Exists(Path.Combine(path, Path.GetFileName(occlusionTex))))
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
								if (!File.Exists(Path.Combine(path, Path.GetFileName(emissiveTex))))
									File.Copy(emissiveTex, Path.Combine(path, Path.GetFileName(emissiveTex)), true);
							}
						}
						gltfText["images"] = images;
						return gltfText.ToString();
					}
				});
			}

			bool hasXml = isGltf && isAc3d;
			string activeName = $"{tileIndex}.{(hasXml ? "xml" : (isGltf ? "gltf" : "ac"))}";
			string placementStr = $"OBJECT_STATIC {activeName} {center.Y.ToString(CultureInfo.InvariantCulture)} {center.X.ToString(CultureInfo.InvariantCulture)} {center.Z.ToString(CultureInfo.InvariantCulture)} {(hasXml ? 0 : (isAc3d && !isGltf ? 90 : 270))} {0} {(isAc3d && !isGltf ? 0 : 90)}";
			if (hasXml)
			{
				XDocument doc = new(
				new XElement("PropertyList",
					new XElement("model",
						new XElement("name", $"ac-{tileIndex}"),
						new XElement("path", $"{tileIndex}.ac")),
					new XElement("model",
						new XElement("name", $"gltf-{tileIndex}"),
						new XElement("path", $"{tileIndex}.gltf")),
					new XElement("animation",
						new XElement("object-name", $"ac-{tileIndex}"),
						new XElement("type", "rotate"),
						new XElement("offset-deg", "90"),
						new XElement("axis",
							new XElement("z", "1"))),
					new XElement("animation",
						new XElement("object-name", $"gltf-{tileIndex}"),
						new XElement("type", "rotate"),
						new XElement("offset-deg", "270"),
						new XElement("axis",
							new XElement("z", "1"))),
					new XElement("animation",
						new XElement("object-name", $"gltf-{tileIndex}"),
						new XElement("type", "rotate"),
						new XElement("offset-deg", "90"),
						new XElement("axis",
							new XElement("x", "1"))),
					new XElement("animation",
						new XElement("object-name", $"gltf-{tileIndex}"),
						new XElement("type", "select"),
						new XElement("condition",
							new XElement("not",
								new XElement("equals",
									new XElement("property", "/sim/version/flightgear"),
									new XElement("value", "2024.2.0"))))),
					new XElement("animation",
						new XElement("object-name", $"ac-{tileIndex}"),
						new XElement("type", "select"),
						new XElement("condition",
							new XElement("equals",
								new XElement("property", "/sim/version/flightgear"),
								new XElement("value", "2024.2.0"))))));

				doc.Save(Path.Combine(path, $"{tileIndex}.xml"));
			}
			File.WriteAllText(Path.Combine(path, $"{tileIndex}.stg"), placementStr);
			if (AbortAndSave)
			{
				Logger.Info("Conversion aborted by user; saving progress.");
				return;
			}
		}

		// Report unused LibraryObjects (placements without models)
		List<Guid> unusedGuids = [.. libraryObjects.Keys.Where(guid => !guidsWithModels.Contains(guid))];
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


	public SceneBuilder ConvertSceneryGltf(string inputPath, string outputPath, KeyValuePair<int, List<ModelReference>> kvp, Vector3 center)
	{
		int tileIndex = kvp.Key;
		List<ModelReference> modelRefs = [.. kvp.Value.OrderByDescending(mr => mr.size)];
		SceneBuilder scene = new();
		double latOrigin = center.X;
		double lonOrigin = center.Y;
		double altOrigin = center.Z;
		foreach (ModelReference modelRef in modelRefs)
		{
			if (AbortAndCancel)
			{
				Logger.Info("Conversion aborted by user.");
				return scene;
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

							SceneBuilder sceneLocal = CreateGltfModelFromGlb(glbBytes, inputPath, modelRef.file);

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
								if (Terrain.GetTileIndex(libObj.latitude, libObj.longitude) != tileIndex)
								{
									continue;
								}
								Matrix4x4 placementTransform = CreatePlacementTransform(libObj, latOrigin, lonOrigin, altOrigin);
								_ = scene.AddScene(sceneLocal, placementTransform);
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

		bool hasXml = false;
		string activeName = $"{tileIndex}.{(hasXml ? "xml" : "gltf")}";
		string placementStr = $"OBJECT_STATIC {activeName} {lonOrigin} {latOrigin} {altOrigin} {270} {0} {90}";
		File.WriteAllText(Path.Combine(path, $"{tileIndex}.stg"), placementStr);
		if (AbortAndSave)
		{
			Logger.Info("Conversion aborted by user; saving progress.");
			return scene;
		}
		return scene;
	}

	public AcBuilder ConvertSceneryAc3d(string inputPath, string outputPath, KeyValuePair<int, List<ModelReference>> kvp, Vector3 center)
	{
		int tileIndex = kvp.Key;
		List<ModelReference> modelRefs = [.. kvp.Value.OrderByDescending(mr => mr.size)];
		AcBuilder tileScene = new()
		{
			WorldName = $"Tile_{tileIndex}"
		};
		double latOrigin = center.X;
		double lonOrigin = center.Y;
		double altOrigin = center.Z;
		foreach (ModelReference modelRef in modelRefs)
		{
			if (AbortAndCancel)
			{
				Logger.Info("Conversion aborted by user.");
				return tileScene;
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

							AcBuilder sceneLocal = CreateAcModelFromGlb(glbBytes, inputPath, modelRef.file);
							if (!sceneLocal.Objects.Any())
							{
								continue;
							}

							// Write GLB with unique filename (include index to avoid overwrites)
							string safeName = name;
							string outName = glbIndex < lods.Count ? lods[glbIndex].name : $"{safeName}_glb{glbIndex}";
							foreach (LibraryObject libObj in libraryObjectsForModel)
							{
								if (Terrain.GetTileIndex(libObj.latitude, libObj.longitude) != tileIndex)
								{
									continue;
								}
								Matrix4x4 gltfTransform = CreatePlacementTransform(libObj, latOrigin, lonOrigin, altOrigin);
								Matrix4x4 acTransform = ConvertToAcTransform(gltfTransform);
								tileScene.Merge(sceneLocal, acTransform);
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
			if (AbortAndSave)
			{
				Logger.Info("Conversion aborted by user; saving progress.");
				break;
			}
		}
		return tileScene;
	}

	private static SceneBuilder CreateGltfModelFromGltf(byte[] glbBinBytes, JObject json, string inputPath, string file)
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

	private static SceneBuilder CreateGltfModelFromGlb(byte[] glbBytes, string inputPath, string file)
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
		return CreateGltfModelFromGltf(glbBinBytes, json, inputPath, file);
	}

	private static AcBuilder CreateAcModelFromGltf(byte[] glbBinBytes, JObject json, string inputPath, string file)
	{
		return AcBuilder.FromGltf(glbBinBytes, json, inputPath, file);
	}

	private static AcBuilder CreateAcModelFromGlb(byte[] glbBytes, string inputPath, string file)
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

		return CreateAcModelFromGltf(glbBinBytes, json, inputPath, file);
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
			lightElem.AppendChild(doc.CreateElement("pitch-deg"))!.InnerText = light.pitch.ToString();
			lightElem.AppendChild(doc.CreateElement("roll-deg"))!.InnerText = light.roll.ToString();
			lightElem.AppendChild(doc.CreateElement("heading-deg"))!.InnerText = light.heading.ToString();
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

	private static Matrix4x4 CreatePlacementTransform(LibraryObject libObj, double latOrigin, double lonOrigin, double altOrigin)
	{
		const double deg2rad = Math.PI / 180.0;
		double lonOffsetMeters = -(libObj.longitude - lonOrigin) * 111320.0 * Math.Cos(latOrigin * deg2rad);
		double latOffsetMeters = (libObj.latitude - latOrigin) * 110540.0;
		double altOffsetMeters = libObj.altitude - altOrigin;

		Vector3 translation = new((float)lonOffsetMeters, (float)altOffsetMeters, (float)latOffsetMeters);
		float yaw = (float)(-libObj.heading * deg2rad);
		float pitch = (float)(libObj.pitch * deg2rad);
		float roll = (float)(libObj.bank * deg2rad);
		Quaternion rotation = Quaternion.CreateFromYawPitchRoll(yaw, pitch, roll);
		Vector3 scale = new((float)libObj.scale);

		return Matrix4x4.CreateScale(scale) * Matrix4x4.CreateFromQuaternion(rotation) * Matrix4x4.CreateTranslation(translation);
	}

	private static Matrix4x4 ConvertToAcTransform(Matrix4x4 gltfTransform)
	{
		Matrix4x4 temp = Matrix4x4.Multiply(FlipZMatrix, gltfTransform);
		return Matrix4x4.Multiply(temp, FlipZMatrix);
	}

	private static LibraryObject BuildLibraryObject(byte[] bytes)
	{
		double longitude = (BitConverter.ToInt32(bytes, 4) * (360.0 / 805306368.0)) - 180.0;
		double latitude = 90.0 - (BitConverter.ToInt32(bytes, 8) * (180.0 / 536870912.0));
		double altitude = BitConverter.ToInt32(bytes, 12) / 1000.0;
		Flags[] flags = [.. Enum.GetValues<Flags>().Where(f => (BitConverter.ToInt16(bytes, 16) & (1 << (int)f)) != 0)];
		LibraryObject libObj = new()
		{
			longitude = longitude,
			latitude = latitude,
			altitude = flags.Contains(Flags.IsAboveAGL) ? altitude + Terrain.GetElevation((float)latitude, (float)longitude) : altitude,
			flags = flags,
			pitch = Math.Round(BitConverter.ToInt16(bytes, 18) * (360.0 / 65536.0), 3),
			bank = Math.Round(BitConverter.ToInt16(bytes, 20) * (360.0 / 65536.0), 3),
			heading = Math.Round(BitConverter.ToInt16(bytes, 22) * (360.0 / 65536.0), 3),
			imageComplexity = BitConverter.ToUInt16(bytes, 24),
			guid = new Guid(bytes[44..60]),
			scale = BitConverter.ToSingle(bytes, 60)
		};
		Logger.Debug($"{libObj.guid}\t{libObj.longitude:F6}\t{libObj.latitude:F6}\t{libObj.altitude}\t[{string.Join(",", libObj.flags)}]\t{libObj.pitch:F2}\t{libObj.bank:F2}\t{libObj.heading:F2}\t{libObj.imageComplexity}\t{libObj.scale}");
		return libObj;
	}

	private void BuildSimObject(byte[] bytes)
	{
		Vector3 position = new(
			(float)((BitConverter.ToInt32(bytes, 4) * (360.0 / 805306368.0)) - 180.0),
			(float)(90.0 - (BitConverter.ToInt32(bytes, 8) * (180.0 / 536870912.0))),
			(float)(BitConverter.ToInt32(bytes, 12) / 1000.0)
		);
		Vector3 orientation = new(
			(float)Math.Round(BitConverter.ToInt16(bytes, 18) * (360.0 / 65536.0), 3),
			(float)Math.Round(BitConverter.ToInt16(bytes, 20) * (360.0 / 65536.0), 3),
			(float)Math.Round(BitConverter.ToInt16(bytes, 22) * (360.0 / 65536.0), 3)
		);
		float scale = BitConverter.ToSingle(bytes, 44);
		int containerTitleLength = BitConverter.ToUInt16(bytes, 48);
		int containerPathLength = BitConverter.ToUInt16(bytes, 50);
		string containerTitle = BitConverter.ToString(bytes, 52, containerTitleLength).TrimEnd('\0');
		string containerPath = BitConverter.ToString(bytes, 52 + containerTitleLength, containerPathLength).TrimEnd('\0');
		int tileIndex = Terrain.GetTileIndex(position.Y, position.X);
		if (!simObjectsByTile.TryGetValue(tileIndex, out Dictionary<string, SimObject>? simObjects))
		{
			simObjectsByTile[tileIndex] = [];
		}
		if (simObjectsByTile[tileIndex].TryGetValue(containerTitle, out SimObject existingObj))
		{
			existingObj.position.Add(position);
			existingObj.orientation.Add(orientation);
			existingObj.scale.Add(scale);
		}
		else
		{
			simObjectsByTile[tileIndex][containerTitle] = new SimObject
			{
				position = [position],
				flags = [.. Enum.GetValues<Flags>().Where(f => (BitConverter.ToInt16(bytes, 16) & (1 << (int)f)) != 0)],
				orientation = [orientation],
				imageComplexity = BitConverter.ToUInt16(bytes, 24),
				scale = [scale],
				containerTitle = containerTitle,
				containerPath = containerPath,
			};
		}
		Logger.Debug($"SimObject: {simObjectsByTile[tileIndex][containerTitle].containerTitle} at {simObjectsByTile[tileIndex][containerTitle].containerPath}, scale {simObjectsByTile[tileIndex][containerTitle].scale}");
	}

	private static string ConvertIcaoBytesToString(int icaoBytes)
	{

		StringBuilder sb = new();
		icaoBytes >>= 5;
		while (icaoBytes > 37)
		{
			int charVal = icaoBytes % 38;
			icaoBytes = (icaoBytes - charVal) / 38;
			char c = charVal == 0 ? ' ' :
				charVal > 1 && charVal < 12 ? (char)('0' + charVal - 2) :
											  (char)('A' + charVal - 12);
			sb.Insert(0, c);
		}
		return sb.ToString();
	}

	protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
	{
		PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
	}

	private enum Flags
	{
		IsAboveAGL,
		NoAutogenSuppression,
		NoCrash,
		NoFog,
		NoShadow,
		NoZWrite,
		NoZTest,
	}

#pragma warning disable CS0649
	private struct LibraryObject
	{
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

	private struct SimObject
	{
		public List<Vector3> position;
		public Flags[] flags;
		public List<Vector3> orientation;
		public int imageComplexity;
		public string containerTitle;
		public string containerPath;
		public List<double> scale;
	}

	private struct Tower
	{
		public double longitude;
		public double latitude;
		public double altitude;
	}

	enum Designator
	{
		None,
		Left,
		Right,
		Center,
		Water,
		A,
		B
	}

	enum Surface
	{
		Concrete,
		Grass,
		Water,
		Asphalt,
		Clay,
		Snow,
		Ice,
		Dirt,
		Coral,
		Gravel,
		OilTreated,
		SteelMats,
		Bituminous,
		Brick,
		Macadam,
		Planks,
		Sand,
		Shale,
		Tarmac,
		Unknown = 0x00fe,
		UseFs20Material = 0x0200,
		UseFs20ApronMaterial = 0xff03
	}

	enum RunwayMarkingType
	{
		Edges,
		Threshold,
		FixedDistance,
		Touchdown,
		Dashes,
		Ident,
		Precision,
		EdgePavement,
		SingleEnd,
		PrimaryClosed,
		SecondaryClosed,
		PrimaryStol,
		SecondaryStol,
		AltThreshold,
		AltFixedDistance,
		AltTouchdown,
		AltPrecision,
		LeadingZeroIdent,
		NoThresholdEndArrows
	}

	enum RunwayLightType
	{
		EdgeNone,
		EdgeLowIntensity,
		EdgeMediumIntensity,
		EdgeHighIntensity,
		CenterNone,
		CenterLowIntensity,
		CenterMediumIntensity,
		CenterHighIntensity,
		CenterRed
	}

	enum RunwayPatternType
	{
		PrimaryTakeoff,
		PrimaryLanding,
		PrimaryPattern,
		SecondaryTakeoff,
		SecondaryLanding,
		SecondaryPattern
	}

	enum VasiChildType
	{
		PrimaryLeft,
		PrimaryRight,
		SecondaryLeft,
		SecondaryRight
	}

	enum VasiType
	{
		Vasi21,
		Vasi31,
		Vasi22,
		Vasi32,
		Vasi33,
		Papi1,
		Papi2,
		Tricolor,
		PVasi,
		TVasi,
		Ball,
		ApapPanels
	}

	private struct Vasi
	{
		public VasiChildType childType;
		public VasiType type;
		public double biasX;
		public double biasZ;
		public float spacing;
		public float pitch;
	}

	private struct OffsetThreshold
	{
		public Surface fsXSurface;
		public Guid surface;
		public double length;
		public double width;
	}

	private struct BlastPad
	{
		public Surface fsXSurface;
		public Guid surface;
		public double length;
		public double width;
	}

	private struct Overrun
	{
		public Surface fsXSurface;
		public Guid surface;
		public double length;
		public double width;
	}

	enum ApproachLightType
	{
		None,
		ODALS,
		MALSF,
		MALSR,
		SSALF,
		SSALR,
		ALSF1,
		ALSF2,
		RAIL,
		CALVERT,
		CALVERT2,
		MALS,
		SALS,
		SALSF,
		SSALS
	}

	private struct ApproachLight
	{
		public ApproachLightType type;
		public bool endLights;
		public bool reil;
		public bool touchdown;
		public byte strobes;
		public double spacing;
		public double offset;
		public float slope;
	}

	private struct FacilityMaterial
	{
		public int opacity;
		public Guid guid;
		public float tilingU;
		public float tilingV;
		public double width;
		public float falloff;
	}

	private struct Runway
	{
		public int primaryNumber;
		public Designator primaryDesignator;
		public int secondaryNumber;
		public Designator secondaryDesignator;
		public string primaryILSIdent;
		public string secondaryILSIdent;
		public double longitude;
		public double latitude;
		public double altitude;
		public double length;
		public double width;
		public double heading;
		public double patternAltitude;
		public List<RunwayMarkingType> markingTypes;
		public List<RunwayLightType> lightTypes;
		public List<RunwayPatternType> patternTypes;
		public bool groundMerging;
		public bool excludeVegetationAround;
		public float falloff;
		public Guid surface;
		public int[] coloration; // RGBA bytes
		public List<Vasi> vasis;
		public List<OffsetThreshold> offsetThresholds;
		public List<BlastPad> blastPads;
		public List<Overrun> overruns;
		public List<ApproachLight> approachLights;
		public FacilityMaterial facilityMaterial;
	}

	enum RunwayStartType
	{
		Runway,
		Water,
		Helipad
	}

	private struct RunwayStart
	{
		public int runwayNumber;
		public Designator designator;
		public double longitude;
		public double latitude;
		public double altitude;
		public double heading;
		public RunwayStartType type;
	}

	enum TaxiPointType
	{
		Unknown = 0,
		Normal,
		HoldShort,
		IlsHoldShort,
		HoldShortNoDraw,
		IlsHoldShortNoDraw,
	}

	enum TaxiPointOrientation
	{
		Foward = 0,
		Reverse
	}

	private struct TaxiwayPoint
	{
		public double longitude;
		public double latitude;
		public TaxiPointType type;
		public TaxiPointOrientation orientation;
	}

	enum ParkingName
	{
		None,
		Parking,
		NParking,
		NeParking,
		EParking,
		SeParking,
		SParking,
		SwParking,
		WParking,
		NwParking,
		Gate,
		Dock,
		GateA,
		GateB,
		GateC,
		GateD,
		GateE,
		GateF,
		GateG,
		GateH,
		GateI,
		GateJ,
		GateK,
		GateL,
		GateM,
		GateN,
		GateO,
		GateP,
		GateQ,
		GateR,
		GateS,
		GateT,
		GateU,
		GateV,
		GateW,
		GateX,
		GateY,
		GateZ
	}

	enum ParkingPushback
	{
		None,
		Left,
		Right,
		Both
	}

	enum ParkingType
	{
		None,
		RampGa,
		RampGaSmall,
		RampGaMedium,
		RampGaLarge,
		RampCargo,
		RampMilCargo,
		RampMilCombat,
		GateSmall,
		GateMedium,
		GateHeavy,
		DockGa,
		Fuel,
		Vehicle,
		RampGaExtra,
		GateExtra
	}

	private struct TaxiwayParking
	{
		public ParkingName name;
		public ParkingPushback pushback;
		public ParkingType type;
		public uint number;
		public double radius;
		public double heading;
		public float teeOffset1;
		public float teeOffset2;
		public float teeOffset3;
		public float teeOffset4; // labeled as another teeOffset3 in the docs
		public double longitude;
		public double latitude;
		public string[] airlineCodes;
		public bool numberMarking;
		public ParkingName suffix;
		public double numberBiasX;
		public double numberBiasZ;
		public double numberHeading;
	}

	enum TaxiwayPathMaterialType
	{
		BaseTiled,
		Border,
		Center
	}

	private struct TaxiwayPathMaterial
	{
		public byte type;
		public byte opacity;
		public Guid surface;
		public TaxiwayPathMaterialType materialType;
		public float tilingU;
		public float tilingV;
		public float width;
		public float falloff;
	}

	enum TaxiwayPathType
	{
		Unknown,
		Taxi,
		Runway,
		Parking,
		Path,
		Closed,
		Vehicle,
		Road
	}

	enum TaxiwayEdgeType
	{
		None,
		Solid,
		Dashed,
		SolidDashed
	}

	private struct TaxiwayPath
	{
		public ushort start;
		public ushort legacyEnd;
		public Designator designator;
		public TaxiwayPathType type;
		public bool enhanced;
		public bool drawSurface;
		public bool drawDetail;
		public int? runwayNumber; // only if this is a runway
		public byte name; // if it isn't a runway
		public bool centerLine;
		public bool centerLineLighted;
		public TaxiwayEdgeType leftEdge;
		public bool leftEdgeLighted;
		public TaxiwayEdgeType rightEdge;
		public bool rightEdgeLighted;
		public Surface fsXSurface;
		public double width;
		public uint weightLimit;
		public Guid surface;
		public int[] coloration; // RGBA bytes
		public bool groundMerging;
		public bool excludeVegetationAround;
		public bool excludeVegetationInside;
		public ushort end;
		public List<TaxiwayPathMaterial> materials;
	}

	public struct Apron
	{
		public bool drawSurface;
		public bool drawDetail;
		public bool localUV;
		public bool stretchUV;
		public bool groundMerging;
		public bool excludeVegetationAround;
		public bool excludeVegetationInside;
		public byte opacity;
		public int[] coloration; // RGBA bytes
		public Guid surface;
		public float tiling;
		public double heading;
		public float falloff;
		public int priority;
		public List<Vector2> vertices;
		public List<Vector3> tris;
	}

	public struct TaxiwaySign
	{
		public double longitude;
		public double latitude;
		public double heading;
		public byte size;
		public bool justificationRight;
		public string label;
	}

	enum PaintedLineType
	{
		Default,
		HoldShortForward,
		HoldShortBackward,
		HoldShortForwardMarked,
		HoldShortBackwardMarked,
		IlsHoldShort,
		EdgeLineSolid,
		EdgeLineDashed,
		HoldShortTaxiway,
		ServiceDashed,
		EdgeServiceSolid,
		EdgeServiceDashed,
		WideYellow,
		WideWhite,
		WideRed,
		SlimRed,
		EdgeSolidOrtho,
		EdgeSolidOrthoBack,
		NonMovement,
		NonMovementBack,
		EnhancedCenter,
		DefaultLighted,
		HoldShortForwardMarkedL,
		HoldShortBackwardMarkedL,
		HoldShortForwardLighted,
		HoldShortBackwardLighted,
		IlsHoldShortLighted,
		EdgeLineSolidLighted,
		EdgeLineDashedLighted,
		HoldShortTaxiwayLighted,
		ServiceDashedLighted,
		EdgeServiceSolidLighted,
		EdgeServiceDashedLighted,
		WideYellowLighted,
		WideWhiteLighted,
		WideRedLighted,
		SlimRedLighted,
		EdgeSolidOrthoLighted,
		EdgeSolidOrthoBackLight,
		NonMovementLighted,
		NonMovementBackLighted,
		EnhancedCenterLighted
	}

	enum PaintedLineTrueAngle
	{
		None,
		Begin,
		End,
		BothEnds,
		AllPoints
	}

	private struct PaintedLine
	{
		public PaintedLineType type;
		public PaintedLineTrueAngle trueAngle;
		public List<Vector2> vertices;
		public Guid surface;
	}

	private struct PaintedHatchedArea
	{
		public PaintedLineType type;
		public ushort vertexCount;
		public double heading;
		public double spacing;
		public List<Vector2> vertices;
	}

	private struct Jetway
	{
		public ushort parkingNumber;
		public ParkingName gateName;
		public ParkingName suffix;
	}

	private struct LightSupport
	{
		public double longitude;
		public double latitude;
		public double altitude;
		public double altitude2;
		public double heading;
		public float width;
		public float length;
	}

	enum LegType
	{
		Af,
		Ca,
		Cd,
		Cf,
		Ci,
		Cr,
		Df,
		Fa,
		Fc,
		Fd,
		Fm,
		Ha,
		Hf,
		Hm,
		If,
		Pi,
		Rf,
		Tf,
		Va,
		Vd,
		Vi,
		Vm,
		Vr
	}

	enum AltitudeDescriptor
	{
		Empty,
		A,
		Plus,
		Minus,
		B,
		C,
		G,
		H,
		I,
		J,
		V
	}

	enum TurnDirection
	{
		Null,
		Left,
		Right,
		Either
	}

	enum ApproachType
	{
		Unknown,
		Gps,
		Vor,
		Ndb,
		Ils,
		Localizer,
		Sdf,
		Lda,
		Vordme,
		Ndbdme,
		Rnav,
		LocalizerBackcourse
	}

	enum FixType
	{
		Unknown,
		Airport,
		Vor,
		Ndb,
		TerminalNdb,
		Waypoint,
		TerminalWaypoint,
		Localizer,
		Runway
	}

	private struct Leg
	{
		public LegType type;
		public AltitudeDescriptor altitudeDescriptor;
		public TurnDirection turnDirection;
		public bool courseIsTrue;
		public bool timeIsSpecified;
		public bool flyOver;
		public FixType fixType;
		public string fixIdent;
		public string fixRegion;
		public string fixAirport;
		public FixType recommendedType;
		public string recommendedIdent;
		public string recommendedRegion;
		public string recommendedAirport;
		public double theta;
		public float rho;
		public double? trueCourse; // if courseIsTrue
		public double? magneticCourse; // if !courseIsTrue
		public float? time; // if timeIsSpecified
		public float? distance; // if !timeIsSpecified
		public double altitude1;
		public double altitude2;
		public float speedLimit;
		public float verticalAngle;
	}

	private struct Approach
	{
		public char suffix;
		public int runwayNumber;
		public ApproachType type;
		public Designator designator;
		public bool gpsOverlay;
		public FixType fixType;
		public string fixIdent;
		public string fixRegion;
		public string airportIdent;
		public double altitude;
		public double heading;
		public double missedAltitude;
		public List<Leg> approachLegs;
		public List<Leg> missedApproachLegs;
		public List<Leg> transitionLegs;
	}

	public struct ApronEdgeLights
	{
		public int[] coloration;
		public float scale;
		public float falloff;
		public List<Vector2> vertices;
		public List<Vector3> edges; // radius, vertex1, vertex2
	}

	enum HelipadType
	{
		None,
		H,
		Square,
		Circle,
		Medical
	}

	private struct Helipad
	{
		public Surface surface;
		public HelipadType type;
		public bool transparent;
		public bool closed;
		public int[] color; // RGBA bytes
		public double longitude;
		public double latitude;
		public double altitude;
		public double length;
		public double width;
		public double heading;
	}

	private struct ProjectedMesh
	{
		public byte priority;
		public bool groundMerging;
		public LibraryObject libraryObject;
	}

	private struct Airport
	{
		public double longitude;
		public double latitude;
		public double altitude;
		public Tower tower;
		public float magvar;
		public string icao;
		public string regIdent;
		public string name;
		public List<Runway> runways;
		public List<RunwayStart> runwayStarts;
		public List<TaxiwayPoint> taxiwayPoints;
		public List<TaxiwayParking> taxiwayParkings;
		public List<TaxiwayPath> taxiwayPaths;
		public List<string> taxiNames;
		public List<Apron> aprons;
		public List<TaxiwaySign> taxiwaySigns;
		public List<PaintedLine> paintedLines;
		public List<PaintedHatchedArea> paintedHatchedAreas;
		public List<Jetway> jetways;
		public List<LightSupport> lightSupports;
		public List<Approach> approaches;
		public List<ApronEdgeLights> apronEdgeLights;
		public List<Helipad> helipads;
		public List<ProjectedMesh> projectedMeshes;
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

	public struct ModelReference
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
		public float pitch;
		public float roll;
		public float heading;
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