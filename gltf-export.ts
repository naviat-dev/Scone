import { Document, NodeIO } from '@gltf-transform/core';

/** Write explicit accessor data for FlightGear's glTF loader. */
export async function writeFlightGearGltf(filePath: string, document: Document): Promise<void> {
	const root = document.getRoot();
	for (const accessor of root.listAccessors()) {
		// NodeIO expands implicit zeros and sparse overrides when reading. Disable
		// sparse serialization so FG never receives an accessor without bufferView.
		accessor.setSparse(false);
		// Accessors read without a base bufferView may not belong to a buffer yet.
		if (!accessor.getBuffer()) {
			accessor.setBuffer(root.listBuffers()[0] ?? document.createBuffer());
		}
	}
	await new NodeIO().write(filePath, document);
}
