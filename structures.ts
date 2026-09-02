import { vec3, vec2 } from "gl-matrix";

export enum Flags {
	IsAboveAGL,
	NoAutogenSuppression,
	NoCrash,
	NoFog,
	NoShadow,
	NoZWrite,
	NoZTest,
}

export interface LibraryObject {
	position: vec3; // longitude, latitude, altitude
	flags: Flags[];
	orientation: vec3; // pitch, bank, heading
	imageComplexity: number;
	guid: string;
	scale: number;
}

export interface SimObject {
	position: vec3; // longitude, latitude, altitude
	flags: Flags[];
	orientation: vec3; // pitch, bank, heading
	imageComplexity: number;
	containerTitle: string;
	containerPath: string;
	scale: number;
}

export interface ModelReference {
	guid: string;
	file: string;
	size: number;
	offset: number;
}

export interface Tower
{
	longitude: number;
	latitude: number;
	altitude: number;
}

export enum Designator
{
	None,
	Left,
	Right,
	Center,
	Water,
	A,
	B
}

export enum Surface
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

export enum RunwayMarkingType
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

export enum RunwayLightType
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

export enum RunwayPatternType
{
	PrimaryTakeoff,
	PrimaryLanding,
	PrimaryPattern,
	SecondaryTakeoff,
	SecondaryLanding,
	SecondaryPattern
}

export enum VasiChildType
{
	PrimaryLeft,
	PrimaryRight,
	SecondaryLeft,
	SecondaryRight
}

export enum VasiType
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

export interface Vasi
{
	childType: VasiChildType;
	type: VasiType;
	biasX: number;
	biasZ: number;
	spacing: number;
	pitch: number;
}

export interface OffsetThreshold
{
	fsXSurface: Surface;
	surface: string;
	length: number;
	width: number;
}

export interface BlastPad
{
	fsXSurface: Surface;
	surface: string;
	length: number;
	width: number;
}

export interface Overrun
{
	fsXSurface: Surface;
	surface: string;
	length: number;
	width: number;
}

export enum ApproachLightType
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

export interface ApproachLight
{
	type: ApproachLightType;
	endLights: boolean;
	reil: boolean;
	touchdown: boolean;
	strobes: number;
	spacing: number;
	offset: number;
	slope: number;
}

export interface FacilityMaterial
{
	opacity: number;
	guid: string;
	tilingU: number;
	tilingV: number;
	width: number;
	falloff: number;
}

export interface Runway
{
	primaryNumber: number;
	primaryDesignator: Designator;
	secondaryNumber: number;
	secondaryDesignator: Designator;
	primaryILSIdent: string;
	secondaryILSIdent: string;
	longitude: number;
	latitude: number;
	altitude: number;
	length: number;
	width: number;
	heading: number;
	patternAltitude: number;
	markingTypes: RunwayMarkingType[];
	lightTypes: RunwayLightType[];
	patternTypes: RunwayPatternType[];
	groundMerging: boolean;
	excludeVegetationAround: boolean;
	falloff: number;
	surface: string;
	coloration: number[]; // RGBA bytes
	vasis: Vasi[];
	offsetThresholds: OffsetThreshold[];
	blastPads: BlastPad[];
	overruns: Overrun[];
	approachLights: ApproachLight[];
	facilityMaterial: FacilityMaterial;
}

export enum RunwayStartType
{
	Runway,
	Water,
	Helipad
}

export interface RunwayStart
{
	runwayNumber: number;
	designator: Designator;
	longitude: number;
	latitude: number;
	altitude: number;
	heading: number;
	type: RunwayStartType;
}

export enum TaxiPointType
{
	Unknown = 0,
	Normal,
	HoldShort,
	IlsHoldShort,
	HoldShortNoDraw,
	IlsHoldShortNoDraw,
}

export enum TaxiPointOrientation
{
	Foward = 0,
	Reverse
}

export interface TaxiwayPoint
{
	longitude: number;
	latitude: number;
	type: TaxiPointType;
	orientation: TaxiPointOrientation;
}

export enum ParkingName
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

export enum ParkingPushback
{
	None,
	Left,
	Right,
	Both
}

export enum ParkingType
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

export interface TaxiwayParking
{
	name: ParkingName;
	pushback: ParkingPushback;
	type: ParkingType;
	number: number;
	radius: number;
	heading: number;
	teeOffset1: number;
	teeOffset2: number;
	teeOffset3: number;
	teeOffset4: number; // labeled as another teeOffset3 in the docs
	longitude: number;
	latitude: number;
	airlineCodes: string[];
	numberMarking: boolean;
	suffix: ParkingName;
	numberBiasX: number;
	numberBiasZ: number;
	numberHeading: number;
}

export enum TaxiwayPathMaterialType
{
	BaseTiled,
	Border,
	Center
}

export interface TaxiwayPathMaterial
{
	type: number;
	opacity: number;
	surface: string;
	materialType: TaxiwayPathMaterialType;
	tilingU: number;
	tilingV: number;
	width: number;
	falloff: number;
}

export enum TaxiwayPathType
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

export enum TaxiwayEdgeType
{
	None,
	Solid,
	Dashed,
	SolidDashed
}

export interface TaxiwayPath
{
	start: number;
	legacyEnd: number;
	designator: Designator;
	type: TaxiwayPathType;
	enhanced: boolean;
	drawSurface: boolean;
	drawDetail: boolean;
	runwayNumber?: number; // only if this is a runway
	name: number; // if it isn't a runway
	centerLine: boolean;
	centerLineLighted: boolean;
	leftEdge: TaxiwayEdgeType;
	leftEdgeLighted: boolean;
	rightEdge: TaxiwayEdgeType;
	rightEdgeLighted: boolean;
	fsXSurface: Surface;
	width: number;
	weightLimit: number;
	surface: string;
	coloration: number[]; // RGBA bytes
	groundMerging: boolean;
	excludeVegetationAround: boolean;
	excludeVegetationInside: boolean;
	end: number;
	materials: TaxiwayPathMaterial[];
}

export interface Apron
{
	drawSurface: boolean;
	drawDetail: boolean;
	localUV: boolean;
	stretchUV: boolean;
	groundMerging: boolean;
	excludeVegetationAround: boolean;
	excludeVegetationInside: boolean;
	opacity: number;
	coloration: number[]; // RGBA bytes
	surface: string;
	tiling: number;
	heading: number;
	falloff: number;
	priority: number;
	vertices: vec2[];
	tris: vec3[];
}

export interface TaxiwaySign
{
	longitude: number;
	latitude: number;
	heading: number;
	size: number;
	justificationRight: boolean;
	label: string;
}

export enum PaintedLineType
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

export enum PaintedLineTrueAngle
{
	None,
	Begin,
	End,
	BothEnds,
	AllPoints
}

export interface PaintedLine
{
	type: PaintedLineType;
	trueAngle: PaintedLineTrueAngle;
	vertices: vec2[];
	surface: string;
}

export interface PaintedHatchedArea
{
	type: PaintedLineType;
	vertexCount: number;
	heading: number;
	spacing: number;
	vertices: vec2[];
}

export interface Jetway
{
	parkingNumber: number;
	gateName: ParkingName;
	suffix: ParkingName;
}

export interface LightSupport
{
	longitude: number;
	latitude: number;
	altitude: number;
	altitude2: number;
	heading: number;
	width: number;
	length: number;
}

export enum LegType
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

export enum AltitudeDescriptor
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

export enum TurnDirection
{
	Null,
	Left,
	Right,
	Either
}

export enum ApproachType
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

export enum FixType
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

export interface Leg
{
	type: LegType;
	altitudeDescriptor: AltitudeDescriptor;
	turnDirection: TurnDirection;
	courseIsTrue: boolean;
	timeIsSpecified: boolean;
	flyOver: boolean;
	fixType: FixType;
	fixIdent: string;
	fixRegion: string;
	fixAirport: string;
	recommendedType: FixType;
	recommendedIdent: string;
	recommendedRegion: string;
	recommendedAirport: string;
	theta: number;
	rho: number;
	trueCourse: number | null; // if courseIsTrue
	magneticCourse: number | null; // if !courseIsTrue
	time: number | null; // if timeIsSpecified
	distance: number | null; // if !timeIsSpecified
	altitude1: number;
	altitude2: number;
	speedLimit: number;
	verticalAngle: number;
}

export interface Approach
{
	suffix: string;
	runwayNumber: number;
	type: ApproachType;
	designator: Designator;
	gpsOverlay: boolean;
	fixType: FixType;
	fixIdent: string;
	fixRegion: string;
	airportIdent: string;
	altitude: number;
	heading: number;
	missedAltitude: number;
	approachLegs: Leg[];
	missedApproachLegs: Leg[];
	transitionLegs: Leg[];
}

export interface ApronEdgeLights
{
	coloration: number[];
	scale: number;
	falloff: number;
	vertices: vec2[];
	edges: vec3[]; // radius, vertex1, vertex2
}

export enum HelipadType
{
	None,
	H,
	Square,
	Circle,
	Medical
}

export interface Helipad
{
	surface: Surface;
	type: HelipadType;
	transparent: boolean;
	closed: boolean;
	color: number[]; // RGBA bytes
	longitude: number;
	latitude: number;
	altitude: number;
	length: number;
	width: number;
	heading: number;
}

export interface ProjectedMesh
{
	priority: number;
	groundMerging: boolean;
	libraryObject: LibraryObject;
}

export interface Airport
{
	longitude: number;
	latitude: number;
	altitude: number;
	tower: Tower;
	magvar: number;
	icao: string;
	regIdent: string;
	name: string;
	runways: Runway[];
	runwayStarts: RunwayStart[];
	taxiwayPoints: TaxiwayPoint[];
	taxiwayParkings: TaxiwayParking[];
	taxiwayPaths: TaxiwayPath[];
	taxiNames: string[];
	aprons: Apron[];
	taxiwaySigns: TaxiwaySign[];
	paintedLines: PaintedLine[];
	paintedHatchedAreas: PaintedHatchedArea[];
	jetways: Jetway[];
	lightSupports: LightSupport[];
	approaches: Approach[];
	apronEdgeLights: ApronEdgeLights[];
	helipads: Helipad[];
	projectedMeshes: ProjectedMesh[];
}