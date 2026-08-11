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
	private byte[]? _updatedBinaryBuffer;

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

			_updatedBinaryBuffer = null;
			bool fixedIssue = handler(amendedJson, amendedBinary, issue);
			if (_updatedBinaryBuffer is not null)
			{
				amendedBinary = _updatedBinaryBuffer;
			}

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

	private bool FixMeshPrimitiveAttributesAccessorInvalidFormat(JObject gltfJson, byte[] binaryBuffer, GltfValidatorIssue issue)
	{
		if (!TryParseAccessorFormatIssue(issue.Message, out AccessorTypes accessorActualType, out ComponentTypes componentActualType, out IReadOnlyList<(AccessorTypes AccessorType, ComponentTypes ComponentType)> expectedFormats))
		{
			return false;
		}

		if (!TryResolveAccessorFromPointer(gltfJson, issue.Pointer, out int accessorIndex, out string? componentSemantic))
		{
			return false;
		}

		if (gltfJson["accessors"] is not JArray accessors ||
			gltfJson["bufferViews"] is not JArray bufferViews ||
			gltfJson["buffers"] is not JArray buffers ||
			accessorIndex < 0 ||
			accessorIndex >= accessors.Count ||
			accessors[accessorIndex] is not JObject accessor ||
			accessor["bufferView"]?.Type != JTokenType.Integer ||
			accessor["sparse"] is not null)
		{
			return false;
		}

		int sourceBufferViewIndex = accessor["bufferView"]!.Value<int>();
		if (sourceBufferViewIndex < 0 || sourceBufferViewIndex >= bufferViews.Count || bufferViews[sourceBufferViewIndex] is not JObject sourceBufferView)
		{
			return false;
		}

		if (sourceBufferView["buffer"]?.Type != JTokenType.Integer)
		{
			return false;
		}

		int sourceBufferIndex = sourceBufferView["buffer"]!.Value<int>();
		if (sourceBufferIndex != 0 || sourceBufferIndex >= buffers.Count || buffers[sourceBufferIndex] is not JObject sourceBuffer)
		{
			return false;
		}

		AccessorTypes sourceAccessorType = accessorActualType;
		if (accessor["type"]?.Type == JTokenType.String &&
			Enum.TryParse(accessor["type"]!.Value<string>(), out AccessorTypes parsedAccessorType))
		{
			sourceAccessorType = parsedAccessorType;
		}

		ComponentTypes sourceComponentType = componentActualType;
		if (accessor["componentType"]?.Type == JTokenType.Integer)
		{
			int sourceComponentCode = accessor["componentType"]!.Value<int>();
			if (!Enum.IsDefined(typeof(ComponentTypes), sourceComponentCode))
			{
				return false;
			}

			sourceComponentType = (ComponentTypes)sourceComponentCode;
		}

		if (!TrySelectTargetFormat(sourceAccessorType, sourceComponentType, expectedFormats, out AccessorTypes targetAccessorType, out ComponentTypes targetComponentType))
		{
			return false;
		}

		if (targetAccessorType == sourceAccessorType && targetComponentType == sourceComponentType)
		{
			return false;
		}

		int accessorCount = accessor["count"]?.Value<int>() ?? 0;
		if (accessorCount <= 0)
		{
			return false;
		}

		int sourceComponentCount = GetAccessorValueComponentCount(sourceAccessorType);
		int sourceComponentByteLength = GetAccessorComponentByteLength((int)sourceComponentType);
		int sourceElementByteLength = checked(sourceComponentCount * sourceComponentByteLength);

		int sourceBufferViewOffset = sourceBufferView["byteOffset"]?.Value<int>() ?? 0;
		int sourceAccessorOffset = accessor["byteOffset"]?.Value<int>() ?? 0;
		int sourceStride = sourceBufferView["byteStride"]?.Value<int>() ?? sourceElementByteLength;
		if (sourceStride < sourceElementByteLength)
		{
			return false;
		}

		int sourceBaseOffset = checked(sourceBufferViewOffset + sourceAccessorOffset);
		int sourceEndOffset = checked(sourceBaseOffset + ((accessorCount - 1) * sourceStride) + sourceElementByteLength);
		if (sourceBaseOffset < 0 || sourceEndOffset > binaryBuffer.Length)
		{
			return false;
		}

		int targetComponentCount = GetAccessorValueComponentCount(targetAccessorType);
		int targetComponentByteLength = GetAccessorComponentByteLength((int)targetComponentType);
		int targetElementByteLength = checked(targetComponentCount * targetComponentByteLength);
		byte[] convertedBytes = new byte[checked(accessorCount * targetElementByteLength)];

		bool sourceNormalized = accessor["normalized"]?.Value<bool>() ?? false;
		bool targetNormalized = sourceNormalized && targetComponentType != ComponentTypes.FLOAT;

		float[] minValues = Enumerable.Repeat(float.PositiveInfinity, targetComponentCount).ToArray();
		float[] maxValues = Enumerable.Repeat(float.NegativeInfinity, targetComponentCount).ToArray();

		for (int elementIndex = 0; elementIndex < accessorCount; elementIndex++)
		{
			int sourceElementOffset = checked(sourceBaseOffset + (elementIndex * sourceStride));
			int targetElementOffset = checked(elementIndex * targetElementByteLength);

			for (int componentIndex = 0; componentIndex < targetComponentCount; componentIndex++)
			{
				float componentValue;
				if (componentIndex < sourceComponentCount)
				{
					int sourceComponentOffset = checked(sourceElementOffset + (componentIndex * sourceComponentByteLength));
					componentValue = ReadAccessorComponent(binaryBuffer, sourceComponentOffset, (int)sourceComponentType, sourceNormalized);
				}
				else
				{
					componentValue = GetSynthesizedComponentValue(componentSemantic, componentIndex);
				}

				if (float.IsNaN(componentValue) || float.IsInfinity(componentValue))
				{
					componentValue = 0f;
				}

				int targetComponentOffset = checked(targetElementOffset + (componentIndex * targetComponentByteLength));
				WriteAccessorComponent(convertedBytes, targetComponentOffset, (int)targetComponentType, targetNormalized, componentValue);

				if (componentValue < minValues[componentIndex])
				{
					minValues[componentIndex] = componentValue;
				}

				if (componentValue > maxValues[componentIndex])
				{
					maxValues[componentIndex] = componentValue;
				}
			}
		}

		byte[] updatedBinaryBuffer = AppendAligned(binaryBuffer, convertedBytes, 4, out int newBufferViewOffset);

		JObject newBufferView = new()
		{
			["buffer"] = sourceBufferIndex,
			["byteOffset"] = newBufferViewOffset,
			["byteLength"] = convertedBytes.Length
		};

		if (sourceBufferView["target"] is not null)
		{
			newBufferView["target"] = sourceBufferView["target"]!.DeepClone();
		}

		if (sourceBufferView["name"]?.Type == JTokenType.String)
		{
			newBufferView["name"] = $"{sourceBufferView["name"]!.Value<string>()}_Fix_{targetAccessorType}_{targetComponentType}";
		}

		bufferViews.Add(newBufferView);
		accessor["bufferView"] = bufferViews.Count - 1;
		accessor.Property("byteOffset")?.Remove();
		accessor["componentType"] = (int)targetComponentType;
		accessor["type"] = targetAccessorType.ToString();

		if (targetNormalized)
		{
			accessor["normalized"] = true;
		}
		else
		{
			accessor.Property("normalized")?.Remove();
		}

		bool positionSemantic = string.Equals(componentSemantic, "POSITION", StringComparison.OrdinalIgnoreCase);
		if (positionSemantic || accessor["min"] is not null)
		{
			accessor["min"] = new JArray(minValues.Select(value => (double)value));
		}

		if (positionSemantic || accessor["max"] is not null)
		{
			accessor["max"] = new JArray(maxValues.Select(value => (double)value));
		}

		int sourceBufferLength = sourceBuffer["byteLength"]?.Value<int>() ?? 0;
		sourceBuffer["byteLength"] = Math.Max(sourceBufferLength, updatedBinaryBuffer.Length);

		_updatedBinaryBuffer = updatedBinaryBuffer;
		return true;
	}

	private static bool TryParseAccessorFormatIssue(
		string message,
		out AccessorTypes actualAccessorType,
		out ComponentTypes actualComponentType,
		out IReadOnlyList<(AccessorTypes AccessorType, ComponentTypes ComponentType)> expectedFormats)
	{
		actualAccessorType = default;
		actualComponentType = default;
		List<(AccessorTypes AccessorType, ComponentTypes ComponentType)> parsedExpectedFormats = [];
		expectedFormats = parsedExpectedFormats;

		MatchCollection formatPairs = Regex.Matches(message, @"\{([^,}]+),\s*([^}]+)\}");
		if (formatPairs.Count < 2 || !TryParseAccessorFormatPair(formatPairs[0], out actualAccessorType, out actualComponentType))
		{
			return false;
		}

		for (int i = 1; i < formatPairs.Count; i++)
		{
			if (TryParseAccessorFormatPair(formatPairs[i], out AccessorTypes expectedAccessorType, out ComponentTypes expectedComponentType))
			{
				parsedExpectedFormats.Add((expectedAccessorType, expectedComponentType));
			}
		}

		return parsedExpectedFormats.Count > 0;
	}

	private static bool TryParseAccessorFormatPair(Match formatPair, out AccessorTypes accessorType, out ComponentTypes componentType)
	{
		accessorType = default;
		componentType = default;

		string accessorToken = formatPair.Groups[1].Value.Trim().Trim('\'', '"');
		string componentToken = formatPair.Groups[2].Value.Trim().Trim('\'', '"');

		if (!Enum.TryParse(accessorToken, out accessorType))
		{
			return false;
		}

		return Enum.TryParse(componentToken, out componentType);
	}

	private static bool TryResolveAccessorFromPointer(JObject gltfJson, string? pointer, out int accessorIndex, out string? semantic)
	{
		accessorIndex = -1;
		semantic = null;

		if (string.IsNullOrWhiteSpace(pointer))
		{
			return false;
		}

		Match directAccessorPointer = Regex.Match(pointer, @"^/accessors/(?<accessor>[0-9]+)(?:/|$)");
		if (directAccessorPointer.Success)
		{
			return int.TryParse(directAccessorPointer.Groups["accessor"].Value, out accessorIndex);
		}

		Match primitiveAttributePointer = Regex.Match(pointer, @"^/meshes/(?<mesh>[0-9]+)/primitives/(?<primitive>[0-9]+)/attributes/(?<semantic>[^/]+)$");
		if (primitiveAttributePointer.Success)
		{
			return TryResolveAccessorFromPrimitiveAttributePointer(gltfJson, primitiveAttributePointer, out accessorIndex, out semantic);
		}

		Match morphTargetPointer = Regex.Match(pointer, @"^/meshes/(?<mesh>[0-9]+)/primitives/(?<primitive>[0-9]+)/targets/(?<target>[0-9]+)/(?<semantic>[^/]+)$");
		if (morphTargetPointer.Success)
		{
			return TryResolveAccessorFromMorphTargetPointer(gltfJson, morphTargetPointer, out accessorIndex, out semantic);
		}

		return false;
	}

	private static bool TryResolveAccessorFromPrimitiveAttributePointer(JObject gltfJson, Match pointerMatch, out int accessorIndex, out string? semantic)
	{
		accessorIndex = -1;
		semantic = null;

		if (!int.TryParse(pointerMatch.Groups["mesh"].Value, out int meshIndex) ||
			!int.TryParse(pointerMatch.Groups["primitive"].Value, out int primitiveIndex) ||
			gltfJson["meshes"] is not JArray meshes ||
			meshIndex < 0 ||
			meshIndex >= meshes.Count ||
			meshes[meshIndex] is not JObject mesh ||
			mesh["primitives"] is not JArray primitives ||
			primitiveIndex < 0 ||
			primitiveIndex >= primitives.Count ||
			primitives[primitiveIndex] is not JObject primitive ||
			primitive["attributes"] is not JObject attributes)
		{
			return false;
		}

		semantic = pointerMatch.Groups["semantic"].Value.Replace("~1", "/").Replace("~0", "~");
		if (attributes[semantic]?.Type != JTokenType.Integer)
		{
			return false;
		}

		accessorIndex = attributes[semantic]!.Value<int>();
		return accessorIndex >= 0;
	}

	private static bool TryResolveAccessorFromMorphTargetPointer(JObject gltfJson, Match pointerMatch, out int accessorIndex, out string? semantic)
	{
		accessorIndex = -1;
		semantic = null;

		if (!int.TryParse(pointerMatch.Groups["mesh"].Value, out int meshIndex) ||
			!int.TryParse(pointerMatch.Groups["primitive"].Value, out int primitiveIndex) ||
			!int.TryParse(pointerMatch.Groups["target"].Value, out int targetIndex) ||
			gltfJson["meshes"] is not JArray meshes ||
			meshIndex < 0 ||
			meshIndex >= meshes.Count ||
			meshes[meshIndex] is not JObject mesh ||
			mesh["primitives"] is not JArray primitives ||
			primitiveIndex < 0 ||
			primitiveIndex >= primitives.Count ||
			primitives[primitiveIndex] is not JObject primitive ||
			primitive["targets"] is not JArray targets ||
			targetIndex < 0 ||
			targetIndex >= targets.Count ||
			targets[targetIndex] is not JObject target)
		{
			return false;
		}

		semantic = pointerMatch.Groups["semantic"].Value.Replace("~1", "/").Replace("~0", "~");
		if (target[semantic]?.Type != JTokenType.Integer)
		{
			return false;
		}

		accessorIndex = target[semantic]!.Value<int>();
		return accessorIndex >= 0;
	}

	private static bool TrySelectTargetFormat(
		AccessorTypes sourceAccessorType,
		ComponentTypes sourceComponentType,
		IReadOnlyList<(AccessorTypes AccessorType, ComponentTypes ComponentType)> expectedFormats,
		out AccessorTypes targetAccessorType,
		out ComponentTypes targetComponentType)
	{
		targetAccessorType = default;
		targetComponentType = default;

		if (expectedFormats.Count == 0)
		{
			return false;
		}

		int sourceComponentCount = GetAccessorValueComponentCount(sourceAccessorType);
		int sourceElementLength = checked(sourceComponentCount * GetAccessorComponentByteLength((int)sourceComponentType));

		var selectedFormat = expectedFormats
			.Select(format => new
			{
				Format = format,
				AccessorPenalty = format.AccessorType == sourceAccessorType ? 0 : 1,
				ComponentDistance = Math.Abs(GetAccessorValueComponentCount(format.AccessorType) - sourceComponentCount),
				ElementLengthDistance = Math.Abs((GetAccessorValueComponentCount(format.AccessorType) * GetAccessorComponentByteLength((int)format.ComponentType)) - sourceElementLength),
				ComponentPenalty = format.ComponentType == sourceComponentType ? 0 : 1
			})
			.OrderBy(item => item.AccessorPenalty)
			.ThenBy(item => item.ComponentDistance)
			.ThenBy(item => item.ElementLengthDistance)
			.ThenBy(item => item.ComponentPenalty)
			.FirstOrDefault();

		if (selectedFormat is null)
		{
			return false;
		}

		targetAccessorType = selectedFormat.Format.AccessorType;
		targetComponentType = selectedFormat.Format.ComponentType;
		return true;
	}

	private static int GetAccessorValueComponentCount(AccessorTypes accessorType)
	{
		return accessorType switch
		{
			AccessorTypes.SCALAR => 1,
			AccessorTypes.VEC2 => 2,
			AccessorTypes.VEC3 => 3,
			AccessorTypes.VEC4 => 4,
			AccessorTypes.MAT2 => 4,
			AccessorTypes.MAT3 => 9,
			AccessorTypes.MAT4 => 16,
			_ => throw new InvalidDataException($"Unsupported accessor type: {accessorType}")
		};
	}

	private static float GetSynthesizedComponentValue(string? semantic, int componentIndex)
	{
		if (string.Equals(semantic, "TANGENT", StringComparison.OrdinalIgnoreCase) && componentIndex == 3)
		{
			return 1f;
		}

		return 0f;
	}

	private static byte[] AppendAligned(byte[] source, byte[] appended, int alignment, out int byteOffset)
	{
		byteOffset = AlignTo(source.Length, alignment);
		byte[] updated = new byte[checked(byteOffset + appended.Length)];
		Buffer.BlockCopy(source, 0, updated, 0, source.Length);
		Buffer.BlockCopy(appended, 0, updated, byteOffset, appended.Length);
		return updated;
	}

	private static int AlignTo(int value, int alignment)
	{
		int remainder = value % alignment;
		return remainder == 0 ? value : value + (alignment - remainder);
	}

	private static void WriteAccessorComponent(byte[] buffer, int offset, int componentType, bool normalized, float value)
	{
		switch (componentType)
		{
			case 5120:
			{
				int quantized = normalized
					? (int)Math.Round(Math.Clamp(value, -1f, 1f) * 127f)
					: Math.Clamp((int)Math.Round(value), sbyte.MinValue, sbyte.MaxValue);
				buffer[offset] = unchecked((byte)(sbyte)quantized);
				break;
			}
			case 5121:
			{
				int quantized = normalized
					? (int)Math.Round(Math.Clamp(value, 0f, 1f) * 255f)
					: Math.Clamp((int)Math.Round(value), byte.MinValue, byte.MaxValue);
				buffer[offset] = (byte)quantized;
				break;
			}
			case 5122:
			{
				int quantized = normalized
					? (int)Math.Round(Math.Clamp(value, -1f, 1f) * 32767f)
					: Math.Clamp((int)Math.Round(value), short.MinValue, short.MaxValue);
				BitConverter.GetBytes((short)quantized).CopyTo(buffer, offset);
				break;
			}
			case 5123:
			{
				int quantized = normalized
					? (int)Math.Round(Math.Clamp(value, 0f, 1f) * 65535f)
					: Math.Clamp((int)Math.Round(value), ushort.MinValue, ushort.MaxValue);
				BitConverter.GetBytes((ushort)quantized).CopyTo(buffer, offset);
				break;
			}
			case 5125:
			{
				uint quantized;
				if (normalized)
				{
					double scaled = Math.Round(Math.Clamp(value, 0f, 1f) * uint.MaxValue);
					quantized = scaled <= 0d ? 0u : scaled >= uint.MaxValue ? uint.MaxValue : (uint)scaled;
				}
				else
				{
					double rounded = Math.Round(value);
					quantized = rounded <= 0d ? 0u : rounded >= uint.MaxValue ? uint.MaxValue : (uint)rounded;
				}

				BitConverter.GetBytes(quantized).CopyTo(buffer, offset);
				break;
			}
			case 5126:
				BitConverter.GetBytes(value).CopyTo(buffer, offset);
				break;
			default:
				throw new InvalidDataException($"Unsupported accessor componentType: {componentType}");
		}
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
