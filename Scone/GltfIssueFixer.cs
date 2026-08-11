using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace Scone;

enum AccessorTypes
{
	SCALAR,
	VEC2,
	VEC3,
	VEC4,
	MAT2,
	MAT3,
	MAT4
}

enum ComponentTypes
{
	BYTE = 5120,
	UNSIGNED_BYTE = 5121,
	SHORT = 5122,
	UNSIGNED_SHORT = 5123,
	UNSIGNED_INT = 5125,
	FLOAT = 5126
}

public sealed record GltfValidatorIssue(
	string Code,
	string Message,
	string Severity,
	string? Pointer = null,
	string? Details = null);

public enum GltfIssueFixOutcome
{
	Fixed,
	Deferred,
	Unsupported
}

public sealed record GltfIssueFixAttempt(
	GltfValidatorIssue Issue,
	GltfIssueFixOutcome Outcome,
	string HandlerName);

public sealed record GltfIssueFixResult(
	JObject GltfJson,
	byte[] BinaryBuffer,
	IReadOnlyList<GltfIssueFixAttempt> Attempts)
{
	public IReadOnlyList<GltfIssueFixAttempt> FixedAttempts =>
		[..
			Attempts.Where(attempt => attempt.Outcome == GltfIssueFixOutcome.Fixed)
		];

	public IReadOnlyList<GltfIssueFixAttempt> DeferredAttempts =>
		[..
			Attempts.Where(attempt => attempt.Outcome == GltfIssueFixOutcome.Deferred)
		];

	public IReadOnlyList<GltfIssueFixAttempt> UnsupportedAttempts =>
		[..
			Attempts.Where(attempt => attempt.Outcome == GltfIssueFixOutcome.Unsupported)
		];
}

public sealed class GltfIssueFixer
{
	private delegate bool IssueFixHandler(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue);

	private readonly Dictionary<string, IssueFixHandler> _issueFixHandlers = new(StringComparer.Ordinal);

	public GltfIssueFixer()
	{
		RegisterIssueHandlers();
	}

	public GltfIssueFixResult AttemptFixes(JObject gltfJson, byte[] binaryBuffer, IEnumerable<GltfValidatorIssue> issues)
	{
		ArgumentNullException.ThrowIfNull(gltfJson);
		ArgumentNullException.ThrowIfNull(binaryBuffer);
		ArgumentNullException.ThrowIfNull(issues);

		JObject amendedJson = (JObject)gltfJson.DeepClone();
		byte[] amendedBinary = (byte[])binaryBuffer.Clone();
		List<GltfIssueFixAttempt> attempts = [];

		foreach (GltfValidatorIssue issue in issues)
		{
			if (string.IsNullOrWhiteSpace(issue.Code))
			{
				attempts.Add(new GltfIssueFixAttempt(issue, GltfIssueFixOutcome.Unsupported, nameof(TryFixUnhandledIssueCode)));
				continue;
			}

			if (!_issueFixHandlers.TryGetValue(issue.Code, out IssueFixHandler? handler))
			{
				_ = TryFixUnhandledIssueCode(amendedJson, amendedBinary, issue);
				attempts.Add(new GltfIssueFixAttempt(issue, GltfIssueFixOutcome.Unsupported, nameof(TryFixUnhandledIssueCode)));
				continue;
			}

			bool fixedIssue = handler(amendedJson, amendedBinary, issue);
			if (fixedIssue)
			{
				attempts.Add(new GltfIssueFixAttempt(issue, GltfIssueFixOutcome.Fixed, handler.Method.Name));
			}
			else
			{
				attempts.Add(new GltfIssueFixAttempt(issue, GltfIssueFixOutcome.Deferred, handler.Method.Name));
			}
		}

		return new GltfIssueFixResult(amendedJson, amendedBinary, attempts);
	}

	private void RegisterIssueHandlers()
	{
		// IoError
		_issueFixHandlers["IO_ERROR"] = FixIoError;

		// SchemaError
		_issueFixHandlers["ARRAY_LENGTH_NOT_IN_LIST"] = FixArrayLengthNotInList;
		_issueFixHandlers["ARRAY_TYPE_MISMATCH"] = FixArrayTypeMismatch;
		_issueFixHandlers["DUPLICATE_ELEMENTS"] = FixDuplicateElements;
		_issueFixHandlers["EMPTY_ENTITY"] = FixEmptyEntity;
		_issueFixHandlers["INVALID_INDEX"] = FixInvalidIndex;
		_issueFixHandlers["INVALID_JSON"] = FixInvalidJson;
		_issueFixHandlers["INVALID_URI"] = FixInvalidUri;
		_issueFixHandlers["ONE_OF_MISMATCH"] = FixOneOfMismatch;
		_issueFixHandlers["PATTERN_MISMATCH"] = FixPatternMismatch;
		_issueFixHandlers["TYPE_MISMATCH"] = FixTypeMismatch;
		_issueFixHandlers["UNDEFINED_PROPERTY"] = FixUndefinedProperty;
		_issueFixHandlers["UNSATISFIED_DEPENDENCY"] = FixUnsatisfiedDependency;
		_issueFixHandlers["VALUE_MULTIPLE_OF"] = FixValueMultipleOf;
		_issueFixHandlers["VALUE_NOT_IN_RANGE"] = FixValueNotInRange;

		// SemanticError
		_issueFixHandlers["ACCESSOR_MATRIX_ALIGNMENT"] = FixAccessorMatrixAlignment;
		_issueFixHandlers["ACCESSOR_NORMALIZED_INVALID"] = FixAccessorNormalizedInvalid;
		_issueFixHandlers["ACCESSOR_OFFSET_ALIGNMENT"] = FixAccessorOffsetAlignment;
		_issueFixHandlers["ACCESSOR_SPARSE_COUNT_OUT_OF_RANGE"] = FixAccessorSparseCountOutOfRange;
		_issueFixHandlers["ASSET_MIN_VERSION_GREATER_THAN_VERSION"] = FixAssetMinVersionGreaterThanVersion;
		_issueFixHandlers["BUFFER_DATA_URI_MIME_TYPE_INVALID"] = FixBufferDataUriMimeTypeInvalid;
		_issueFixHandlers["BUFFER_VIEW_INVALID_BYTE_STRIDE"] = FixBufferViewInvalidByteStride;
		_issueFixHandlers["BUFFER_VIEW_TOO_BIG_BYTE_STRIDE"] = FixBufferViewTooBigByteStride;
		_issueFixHandlers["CAMERA_XMAG_YMAG_ZERO"] = FixCameraXmagYmagZero;
		_issueFixHandlers["CAMERA_ZFAR_LEQUAL_ZNEAR"] = FixCameraZfarLequalZnear;
		_issueFixHandlers["INVALID_GL_VALUE"] = FixInvalidGlValue;
		_issueFixHandlers["KHR_ANIMATION_POINTER_ANIMATION_CHANNEL_TARGET_NODE"] = FixKhrAnimationPointerAnimationChannelTargetNode;
		_issueFixHandlers["KHR_ANIMATION_POINTER_ANIMATION_CHANNEL_TARGET_PATH"] = FixKhrAnimationPointerAnimationChannelTargetPath;
		_issueFixHandlers["KHR_LIGHTS_PUNCTUAL_LIGHT_SPOT_ANGLES"] = FixKhrLightsPunctualLightSpotAngles;
		_issueFixHandlers["MESH_INVALID_WEIGHTS_COUNT"] = FixMeshInvalidWeightsCount;
		_issueFixHandlers["MESH_PRIMITIVES_UNEQUAL_TARGETS_COUNT"] = FixMeshPrimitivesUnequalTargetsCount;
		_issueFixHandlers["MESH_PRIMITIVE_INDEXED_SEMANTIC_CONTINUITY"] = FixMeshPrimitiveIndexedSemanticContinuity;
		_issueFixHandlers["MESH_PRIMITIVE_INVALID_ATTRIBUTE"] = FixMeshPrimitiveInvalidAttribute;
		_issueFixHandlers["MESH_PRIMITIVE_JOINTS_WEIGHTS_MISMATCH"] = FixMeshPrimitiveJointsWeightsMismatch;
		_issueFixHandlers["NODE_MATRIX_NON_TRS"] = FixNodeMatrixNonTrs;
		_issueFixHandlers["NODE_MATRIX_TRS"] = FixNodeMatrixTrs;
		_issueFixHandlers["NODE_SKIN_NO_SCENE"] = FixNodeSkinNoScene;
		_issueFixHandlers["NON_REQUIRED_EXTENSION"] = FixNonRequiredExtension;
		_issueFixHandlers["ROTATION_NON_UNIT"] = FixRotationNonUnit;
		_issueFixHandlers["SKIN_NO_COMMON_ROOT"] = FixSkinNoCommonRoot;
		_issueFixHandlers["SKIN_SKELETON_INVALID"] = FixSkinSkeletonInvalid;
		_issueFixHandlers["UNKNOWN_ASSET_MAJOR_VERSION"] = FixUnknownAssetMajorVersion;
		_issueFixHandlers["UNUSED_EXTENSION_REQUIRED"] = FixUnusedExtensionRequired;

		// LinkError
		_issueFixHandlers["ACCESSOR_SMALL_BYTESTRIDE"] = FixAccessorSmallBytestride;
		_issueFixHandlers["ACCESSOR_TOO_LONG"] = FixAccessorTooLong;
		_issueFixHandlers["ACCESSOR_TOTAL_OFFSET_ALIGNMENT"] = FixAccessorTotalOffsetAlignment;
		_issueFixHandlers["ACCESSOR_USAGE_OVERRIDE"] = FixAccessorUsageOverride;
		_issueFixHandlers["ANIMATION_CHANNEL_TARGET_NODE_MATRIX"] = FixAnimationChannelTargetNodeMatrix;
		_issueFixHandlers["ANIMATION_CHANNEL_TARGET_NODE_WEIGHTS_NO_MORPHS"] = FixAnimationChannelTargetNodeWeightsNoMorphs;
		_issueFixHandlers["ANIMATION_DUPLICATE_TARGETS"] = FixAnimationDuplicateTargets;
		_issueFixHandlers["ANIMATION_SAMPLER_ACCESSOR_WITH_BYTESTRIDE"] = FixAnimationSamplerAccessorWithBytestride;
		_issueFixHandlers["ANIMATION_SAMPLER_INPUT_ACCESSOR_INVALID_FORMAT"] = FixAnimationSamplerInputAccessorInvalidFormat;
		_issueFixHandlers["ANIMATION_SAMPLER_INPUT_ACCESSOR_TOO_FEW_ELEMENTS"] = FixAnimationSamplerInputAccessorTooFewElements;
		_issueFixHandlers["ANIMATION_SAMPLER_INPUT_ACCESSOR_WITHOUT_BOUNDS"] = FixAnimationSamplerInputAccessorWithoutBounds;
		_issueFixHandlers["ANIMATION_SAMPLER_OUTPUT_ACCESSOR_INVALID_COUNT"] = FixAnimationSamplerOutputAccessorInvalidCount;
		_issueFixHandlers["ANIMATION_SAMPLER_OUTPUT_ACCESSOR_INVALID_FORMAT"] = FixAnimationSamplerOutputAccessorInvalidFormat;
		_issueFixHandlers["BUFFER_MISSING_GLB_DATA"] = FixBufferMissingGlbData;
		_issueFixHandlers["BUFFER_VIEW_TARGET_OVERRIDE"] = FixBufferViewTargetOverride;
		_issueFixHandlers["BUFFER_VIEW_TOO_LONG"] = FixBufferViewTooLong;
		_issueFixHandlers["IMAGE_BUFFER_VIEW_WITH_BYTESTRIDE"] = FixImageBufferViewWithBytestride;
		_issueFixHandlers["INVALID_IBM_ACCESSOR_COUNT"] = FixInvalidIbmAccessorCount;
		_issueFixHandlers["KHR_MATERIALS_VARIANTS_NON_UNIQUE_VARIANT"] = FixKhrMaterialsVariantsNonUniqueVariant;
		_issueFixHandlers["MESH_PRIMITIVE_ACCESSOR_UNALIGNED"] = FixMeshPrimitiveAccessorUnaligned;
		_issueFixHandlers["MESH_PRIMITIVE_ACCESSOR_WITHOUT_BYTESTRIDE"] = FixMeshPrimitiveAccessorWithoutBytestride;
		_issueFixHandlers["MESH_PRIMITIVE_ATTRIBUTES_ACCESSOR_INVALID_FORMAT"] = FixMeshPrimitiveAttributesAccessorInvalidFormat;
		_issueFixHandlers["MESH_PRIMITIVE_ATTRIBUTES_ACCESSOR_UNSIGNED_INT"] = FixMeshPrimitiveAttributesAccessorUnsignedInt;
		_issueFixHandlers["MESH_PRIMITIVE_INDICES_ACCESSOR_INVALID_FORMAT"] = FixMeshPrimitiveIndicesAccessorInvalidFormat;
		_issueFixHandlers["MESH_PRIMITIVE_INDICES_ACCESSOR_WITH_BYTESTRIDE"] = FixMeshPrimitiveIndicesAccessorWithBytestride;
		_issueFixHandlers["MESH_PRIMITIVE_MORPH_TARGET_INVALID_ATTRIBUTE_COUNT"] = FixMeshPrimitiveMorphTargetInvalidAttributeCount;
		_issueFixHandlers["MESH_PRIMITIVE_MORPH_TARGET_NO_BASE_ACCESSOR"] = FixMeshPrimitiveMorphTargetNoBaseAccessor;
		_issueFixHandlers["MESH_PRIMITIVE_NO_TANGENT_SPACE"] = FixMeshPrimitiveNoTangentSpace;
		_issueFixHandlers["MESH_PRIMITIVE_POSITION_ACCESSOR_WITHOUT_BOUNDS"] = FixMeshPrimitivePositionAccessorWithoutBounds;
		_issueFixHandlers["MESH_PRIMITIVE_TOO_FEW_TEXCOORDS"] = FixMeshPrimitiveTooFewTexcoords;
		_issueFixHandlers["MESH_PRIMITIVE_UNEQUAL_ACCESSOR_COUNT"] = FixMeshPrimitiveUnequalAccessorCount;
		_issueFixHandlers["NODE_LOOP"] = FixNodeLoop;
		_issueFixHandlers["NODE_PARENT_OVERRIDE"] = FixNodeParentOverride;
		_issueFixHandlers["NODE_SKIN_WITH_NON_SKINNED_MESH"] = FixNodeSkinWithNonSkinnedMesh;
		_issueFixHandlers["NODE_WEIGHTS_INVALID"] = FixNodeWeightsInvalid;
		_issueFixHandlers["SCENE_NON_ROOT_NODE"] = FixSceneNonRootNode;
		_issueFixHandlers["SKIN_IBM_ACCESSOR_WITH_BYTESTRIDE"] = FixSkinIbmAccessorWithBytestride;
		_issueFixHandlers["SKIN_IBM_INVALID_FORMAT"] = FixSkinIbmInvalidFormat;
		_issueFixHandlers["TEXTURE_INVALID_IMAGE_MIME_TYPE"] = FixTextureInvalidImageMimeType;
		_issueFixHandlers["UNDECLARED_EXTENSION"] = FixUndeclaredExtension;
		_issueFixHandlers["UNEXPECTED_EXTENSION_OBJECT"] = FixUnexpectedExtensionObject;
		_issueFixHandlers["UNRESOLVED_REFERENCE"] = FixUnresolvedReference;

		// DataError
		_issueFixHandlers["ACCESSOR_ANIMATION_INPUT_NEGATIVE"] = FixAccessorAnimationInputNegative;
		_issueFixHandlers["ACCESSOR_ANIMATION_INPUT_NON_INCREASING"] = FixAccessorAnimationInputNonIncreasing;
		_issueFixHandlers["ACCESSOR_ANIMATION_SAMPLER_OUTPUT_NON_NORMALIZED_QUATERNION"] = FixAccessorAnimationSamplerOutputNonNormalizedQuaternion;
		_issueFixHandlers["ACCESSOR_ELEMENT_OUT_OF_MAX_BOUND"] = FixAccessorElementOutOfMaxBound;
		_issueFixHandlers["ACCESSOR_ELEMENT_OUT_OF_MIN_BOUND"] = FixAccessorElementOutOfMinBound;
		_issueFixHandlers["ACCESSOR_INDEX_OOB"] = FixAccessorIndexOob;
		_issueFixHandlers["ACCESSOR_INDEX_PRIMITIVE_RESTART"] = FixAccessorIndexPrimitiveRestart;
		_issueFixHandlers["ACCESSOR_INVALID_FLOAT"] = FixAccessorInvalidFloat;
		_issueFixHandlers["ACCESSOR_INVALID_IBM"] = FixAccessorInvalidIbm;
		_issueFixHandlers["ACCESSOR_INVALID_SIGN"] = FixAccessorInvalidSign;
		_issueFixHandlers["ACCESSOR_JOINTS_INDEX_DUPLICATE"] = FixAccessorJointsIndexDuplicate;
		_issueFixHandlers["ACCESSOR_JOINTS_INDEX_OOB"] = FixAccessorJointsIndexOob;
		_issueFixHandlers["ACCESSOR_MAX_MISMATCH"] = FixAccessorMaxMismatch;
		_issueFixHandlers["ACCESSOR_MIN_MISMATCH"] = FixAccessorMinMismatch;
		_issueFixHandlers["ACCESSOR_NON_CLAMPED"] = FixAccessorNonClamped;
		_issueFixHandlers["ACCESSOR_SPARSE_INDEX_OOB"] = FixAccessorSparseIndexOob;
		_issueFixHandlers["ACCESSOR_SPARSE_INDICES_NON_INCREASING"] = FixAccessorSparseIndicesNonIncreasing;
		_issueFixHandlers["ACCESSOR_VECTOR3_NON_UNIT"] = FixAccessorVector3NonUnit;
		_issueFixHandlers["ACCESSOR_WEIGHTS_NEGATIVE"] = FixAccessorWeightsNegative;
		_issueFixHandlers["ACCESSOR_WEIGHTS_NON_NORMALIZED"] = FixAccessorWeightsNonNormalized;
		_issueFixHandlers["BUFFER_BYTE_LENGTH_MISMATCH"] = FixBufferByteLengthMismatch;
		_issueFixHandlers["IMAGE_DATA_INVALID"] = FixImageDataInvalid;
		_issueFixHandlers["IMAGE_MIME_TYPE_INVALID"] = FixImageMimeTypeInvalid;
		_issueFixHandlers["IMAGE_NON_ENABLED_MIME_TYPE"] = FixImageNonEnabledMimeType;
		_issueFixHandlers["IMAGE_UNEXPECTED_EOS"] = FixImageUnexpectedEos;

		// GlbError
		_issueFixHandlers["GLB_CHUNK_LENGTH_UNALIGNED"] = FixGlbChunkLengthUnaligned;
		_issueFixHandlers["GLB_CHUNK_TOO_BIG"] = FixGlbChunkTooBig;
		_issueFixHandlers["GLB_DUPLICATE_CHUNK"] = FixGlbDuplicateChunk;
		_issueFixHandlers["GLB_EMPTY_CHUNK"] = FixGlbEmptyChunk;
		_issueFixHandlers["GLB_INVALID_MAGIC"] = FixGlbInvalidMagic;
		_issueFixHandlers["GLB_INVALID_VERSION"] = FixGlbInvalidVersion;
		_issueFixHandlers["GLB_LENGTH_MISMATCH"] = FixGlbLengthMismatch;
		_issueFixHandlers["GLB_LENGTH_TOO_SMALL"] = FixGlbLengthTooSmall;
		_issueFixHandlers["GLB_UNEXPECTED_BIN_CHUNK"] = FixGlbUnexpectedBinChunk;
		_issueFixHandlers["GLB_UNEXPECTED_END_OF_CHUNK_DATA"] = FixGlbUnexpectedEndOfChunkData;
		_issueFixHandlers["GLB_UNEXPECTED_END_OF_CHUNK_HEADER"] = FixGlbUnexpectedEndOfChunkHeader;
		_issueFixHandlers["GLB_UNEXPECTED_END_OF_HEADER"] = FixGlbUnexpectedEndOfHeader;
		_issueFixHandlers["GLB_UNEXPECTED_FIRST_CHUNK"] = FixGlbUnexpectedFirstChunk;
	}

	private static bool DeferIssue(byte[] binaryBuffer)
	{
		// TODO: Implement issue-specific fix logic in individual handlers.
		return false;
	}

	private static bool FixIoError(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixArrayLengthNotInList(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixArrayTypeMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixDuplicateElements(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixEmptyEntity(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixInvalidIndex(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixInvalidJson(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixInvalidUri(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixOneOfMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixPatternMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixTypeMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixUndefinedProperty(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixUnsatisfiedDependency(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixValueMultipleOf(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixValueNotInRange(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorMatrixAlignment(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorNormalizedInvalid(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorOffsetAlignment(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorSparseCountOutOfRange(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAssetMinVersionGreaterThanVersion(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixBufferDataUriMimeTypeInvalid(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixBufferViewInvalidByteStride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixBufferViewTooBigByteStride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixCameraXmagYmagZero(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixCameraZfarLequalZnear(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixInvalidGlValue(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixKhrAnimationPointerAnimationChannelTargetNode(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixKhrAnimationPointerAnimationChannelTargetPath(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixKhrLightsPunctualLightSpotAngles(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshInvalidWeightsCount(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitivesUnequalTargetsCount(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveIndexedSemanticContinuity(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveInvalidAttribute(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveJointsWeightsMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNodeMatrixNonTrs(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNodeMatrixTrs(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNodeSkinNoScene(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNonRequiredExtension(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixRotationNonUnit(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixSkinNoCommonRoot(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixSkinSkeletonInvalid(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixUnknownAssetMajorVersion(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixUnusedExtensionRequired(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorSmallBytestride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorTooLong(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorTotalOffsetAlignment(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorUsageOverride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationChannelTargetNodeMatrix(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationChannelTargetNodeWeightsNoMorphs(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationDuplicateTargets(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationSamplerAccessorWithBytestride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationSamplerInputAccessorInvalidFormat(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationSamplerInputAccessorTooFewElements(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationSamplerInputAccessorWithoutBounds(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationSamplerOutputAccessorInvalidCount(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAnimationSamplerOutputAccessorInvalidFormat(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixBufferMissingGlbData(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixBufferViewTargetOverride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixBufferViewTooLong(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixImageBufferViewWithBytestride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixInvalidIbmAccessorCount(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixKhrMaterialsVariantsNonUniqueVariant(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveAccessorUnaligned(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveAccessorWithoutBytestride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveAttributesAccessorInvalidFormat(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue)
	{
		MatchCollection dataTypes = new Regex(@"\{[^}]+\}").Matches(issue.Message);
		if (dataTypes.Count < 2)
		{
			return false;
		}
		MatchCollection dataActual = new Regex(@"\{(.+), (.+)\}").Matches(dataTypes[0].Value);
		MatchCollection[] dataExpected = [.. dataTypes.Skip(1).Select(dt => new Regex(@"\{(.+), (.+)\}").Matches(dt.Value))];
		if (dataActual.Count < 1 || dataExpected.Length < 1 || dataExpected.Any(dt => dt.Count < 1))
		{
			return false;
		}
		Enum.TryParse(dataActual[0].Groups[1].Value, out AccessorTypes accessorActualType);
		Enum.TryParse(dataActual[0].Groups[2].Value, out ComponentTypes componentActualType);
        MatchCollection? targetData = null;
        try 
		{
			// See if we can keep the accessor type the same and just change the component type to one of the expected types
			targetData = dataExpected.First(dt => Enum.TryParse(dt[0].Groups[1].Value, out AccessorTypes accessorType) && accessorType == accessorActualType);
		}
		catch (InvalidOperationException)
		{
			// If we can't find a match for the accessor type, pick the type that requires the least amount of data reduction/synthesis
			int closestMatchScore = int.MaxValue;
			foreach (MatchCollection dt in dataExpected)
			{
				if (Enum.TryParse(dt[0].Groups[1].Value, out AccessorTypes accessorType) && ((Math.Abs(accessorType - accessorActualType) == closestMatchScore && accessorType > accessorActualType) || (Math.Abs(accessorType - accessorActualType) < closestMatchScore)))
				{
					closestMatchScore = Math.Abs(accessorType - accessorActualType);
					targetData = dt;
				}
			}
			targetData ??= dataExpected[0];
		}
		Enum.TryParse(targetData[0].Groups[1].Value, out AccessorTypes targetAccessorType);
		Enum.TryParse(targetData[0].Groups[2].Value, out ComponentTypes targetComponentType);
		return true;
	}

	private static bool FixMeshPrimitiveAttributesAccessorUnsignedInt(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveIndicesAccessorInvalidFormat(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveIndicesAccessorWithBytestride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveMorphTargetInvalidAttributeCount(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveMorphTargetNoBaseAccessor(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveNoTangentSpace(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitivePositionAccessorWithoutBounds(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveTooFewTexcoords(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixMeshPrimitiveUnequalAccessorCount(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNodeLoop(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNodeParentOverride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNodeSkinWithNonSkinnedMesh(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixNodeWeightsInvalid(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixSceneNonRootNode(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixSkinIbmAccessorWithBytestride(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixSkinIbmInvalidFormat(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixTextureInvalidImageMimeType(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixUndeclaredExtension(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixUnexpectedExtensionObject(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixUnresolvedReference(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorAnimationInputNegative(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorAnimationInputNonIncreasing(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorAnimationSamplerOutputNonNormalizedQuaternion(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorElementOutOfMaxBound(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorElementOutOfMinBound(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorIndexOob(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorIndexPrimitiveRestart(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorInvalidFloat(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorInvalidIbm(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorInvalidSign(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorJointsIndexDuplicate(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorJointsIndexOob(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorMaxMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorMinMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorNonClamped(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorSparseIndexOob(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorSparseIndicesNonIncreasing(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorVector3NonUnit(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorWeightsNegative(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixAccessorWeightsNonNormalized(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixBufferByteLengthMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixImageDataInvalid(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixImageMimeTypeInvalid(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixImageNonEnabledMimeType(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixImageUnexpectedEos(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbChunkLengthUnaligned(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbChunkTooBig(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbDuplicateChunk(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbEmptyChunk(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbInvalidMagic(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbInvalidVersion(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbLengthMismatch(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbLengthTooSmall(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbUnexpectedBinChunk(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbUnexpectedEndOfChunkData(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbUnexpectedEndOfChunkHeader(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbUnexpectedEndOfHeader(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool FixGlbUnexpectedFirstChunk(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue) =>
		DeferIssue(binaryBuffer);

	private static bool TryFixUnhandledIssueCode(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue)
	{
		// TODO: Implement a generic fallback strategy for unknown issue codes.
		return DeferIssue(binaryBuffer);
	}

	private static int GetAccessorComponentByteLength(int componentType)
	{
		return componentType switch
		{
			5120 => sizeof(sbyte),
			5121 => sizeof(byte),
			5122 => sizeof(short),
			5123 => sizeof(ushort),
			5125 => sizeof(uint),
			5126 => sizeof(float),
			_ => throw new InvalidDataException($"Unsupported accessor componentType: {componentType}")
		};
	}

	private static float ReadAccessorComponent(byte[] buffer, int offset, int componentType, bool normalized)
	{
		return componentType switch
		{
			5120 => normalized
				? Math.Max((sbyte)buffer[offset] / 127f, -1f)
				: (sbyte)buffer[offset],
			5121 => normalized
				? buffer[offset] / 255f
				: buffer[offset],
			5122 => normalized
				? Math.Max(BitConverter.ToInt16(buffer, offset) / 32767f, -1f)
				: BitConverter.ToInt16(buffer, offset),
			5123 => normalized
				? BitConverter.ToUInt16(buffer, offset) / 65535f
				: BitConverter.ToUInt16(buffer, offset),
			5125 => normalized
				? BitConverter.ToUInt32(buffer, offset) / (float)uint.MaxValue
				: BitConverter.ToUInt32(buffer, offset),
			5126 => BitConverter.ToSingle(buffer, offset),
			_ => throw new InvalidDataException($"Unsupported accessor componentType: {componentType}")
		};
	}
}
