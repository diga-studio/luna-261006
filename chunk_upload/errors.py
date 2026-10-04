"""Exception types for the chunk upload library."""


class UploadError(Exception):
    """Base class for all upload errors."""


class SessionNotFound(UploadError):
    """The referenced session does not exist."""


class SessionCompleted(UploadError):
    """The session is already completed and rejects new bytes."""


class OffsetMismatch(UploadError):
    """Chunk starts beyond the confirmed prefix (a gap)."""


class ContentConflict(UploadError):
    """Retried range differs from, or extends beyond, confirmed bytes."""


class ChunkTooLarge(UploadError):
    """A single chunk exceeds the maximum allowed size."""


class ObjectTooLarge(UploadError):
    """The object would exceed the maximum allowed size."""


class DigestMismatch(UploadError):
    """The expected SHA-256 digest does not match confirmed bytes."""


class StorageCorrupted(UploadError):
    """On-disk state is inconsistent beyond crash to recover from."""
