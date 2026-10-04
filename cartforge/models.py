"""Data model for CartForge cross-store discount optimization.

All monetary amounts are integer cents. Inputs are assumed to be already
aggregated per store, with all promotions within their validity period and
immutable during a single computation.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Activity:
    """A store-level spend-and-save promotion."""

    id: str
    min_amount: int
    reduction: int


@dataclass(frozen=True)
class Store:
    """A store with its aggregated goods total and shipping parameters."""

    id: str
    goods_amount: int
    base_shipping: int
    free_shipping_threshold: int
    activities: tuple[Activity, ...] = ()


@dataclass(frozen=True)
class Coupon:
    """A checkout-wide coupon.

    Exactly one of ``percent`` / ``value`` must be set: ``percent`` is an
    integer in 1..50 meaning a percentage off, ``value`` is a fixed amount
    off in cents.
    """

    id: str
    store_ids: frozenset[str]
    min_amount: int
    percent: int | None = None
    value: int | None = None

    @property
    def is_percent(self) -> bool:
        return self.percent is not None


@dataclass(frozen=True)
class StoreChoice:
    """The discounts selected for one store in a plan."""

    store_id: str
    activity_id: str | None = None
    percent_coupon_id: str | None = None
    fixed_coupon_id: str | None = None


@dataclass(frozen=True)
class Plan:
    """A full checkout plan: one choice per store."""

    choices: tuple[StoreChoice, ...] = ()


@dataclass(frozen=True)
class StoreBreakdown:
    """Per-stage amounts for one store, all in integer cents."""

    store_id: str
    original: int
    after_activity: int
    after_percent: int
    after_fixed: int
    shipping: int
    total: int


@dataclass(frozen=True)
class QuoteResult:
    """Result of ``quote``: an optimal plan plus its computed breakdown."""

    plan: Plan
    breakdowns: tuple[StoreBreakdown, ...]
    total: int


class InvalidPlanError(ValueError):
    """Raised by ``evaluate`` when a plan is not legal for the inputs."""
