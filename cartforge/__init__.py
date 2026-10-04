"""CartForge: cross-store optimal discount computation for one checkout."""

from .evaluator import evaluate
from .models import (
    Activity,
    Coupon,
    InvalidPlanError,
    Plan,
    QuoteResult,
    Store,
    StoreBreakdown,
    StoreChoice,
)
from .optimizer import quote

__all__ = [
    "Activity",
    "Coupon",
    "InvalidPlanError",
    "Plan",
    "QuoteResult",
    "Store",
    "StoreBreakdown",
    "StoreChoice",
    "evaluate",
    "quote",
]
