"""Exception types for layerstore."""


class LayerStoreError(Exception):
    """Base class for all layerstore errors."""


class SessionNotFoundError(LayerStoreError):
    """The referenced upload session does not exist."""


class OffsetMismatchError(LayerStoreError):
    """Chunk starts beyond the confirmed prefix (gap)."""


class PartialOverlapError(LayerStoreError):
    """Chunk partially overlaps the confirmed prefix and extends beyond it."""


class ContentMismatchError(LayerStoreError):
    """Retried range bytes differ from the confirmed prefix."""


class DigestMismatchError(LayerStoreError):
    """Provided SHA-256 does not match the confirmed bytes."""


class SessionCompletedError(LayerStoreError):
    """Operation not allowed on a completed session."""


class ChunkTooLargeError(LayerStoreError):
    """A single chunk exceeds the maximum allowed size."""


class ObjectTooLargeError(LayerStoreError):
    """The object would exceed the maximum allowed size."""


class StoreCorruptError(LayerStoreError):
    """On-disk state is inconsistent and cannot be recovered."""
