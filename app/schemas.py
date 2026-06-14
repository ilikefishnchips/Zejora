from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


Priority = Literal["low", "medium", "high"]
TaskState = Literal["pending", "urgent", "overdue", "completed"]


def clean_text(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("must not be blank")
    return value


def require_aware_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("due_at must include a timezone offset")
    return value.astimezone(UTC)


class SubjectBase(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#FFB7B2", pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return clean_text(value)


class SubjectCreate(SubjectBase):
    pass


class SubjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return clean_text(value) if value is not None else value


class SubjectRead(SubjectBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    task_count: int = 0
    created_at: datetime
    updated_at: datetime


class TaskBase(BaseModel):
    title: str = Field(min_length=1, max_length=140)
    description: str | None = Field(default=None, max_length=2000)
    subject_id: int
    due_at: datetime
    priority: Priority = "medium"
    estimated_hours: float | None = Field(default=None, ge=0, le=100)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        return clean_text(value)

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("due_at")
    @classmethod
    def validate_due_at(cls, value: datetime) -> datetime:
        return require_aware_datetime(value)


class TaskCreate(TaskBase):
    completed: bool = False


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=140)
    description: str | None = Field(default=None, max_length=2000)
    subject_id: int | None = None
    due_at: datetime | None = None
    priority: Priority | None = None
    completed: bool | None = None
    estimated_hours: float | None = Field(default=None, ge=0, le=100)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str | None) -> str | None:
        return clean_text(value) if value is not None else value

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("due_at")
    @classmethod
    def validate_due_at(cls, value: datetime | None) -> datetime | None:
        return require_aware_datetime(value) if value is not None else value


class TaskSubject(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    color: str


class TaskRead(TaskBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    completed: bool
    completed_at: datetime | None
    delay_days: float | None
    postpone_count: int
    created_at: datetime
    updated_at: datetime
    state: TaskState
    is_urgent: bool
    is_overdue: bool
    subject: TaskSubject


class PostponePayload(BaseModel):
    days: int = Field(default=1, ge=1, le=30)


class StatusDistribution(BaseModel):
    completed: int
    pending: int
    overdue: int


class PriorityDistribution(BaseModel):
    low: int
    medium: int
    high: int


class SubjectWorkload(BaseModel):
    subject_id: int
    name: str
    color: str
    task_count: int


class TrendPoint(BaseModel):
    week_start: str
    label: str
    completed: int


class StudyInsight(BaseModel):
    productivity_score: float
    tasks_this_week: int


class AnalyticsSummary(BaseModel):
    total: int
    completed: int
    pending: int
    overdue: int
    urgent: int
    due_today: int
    due_next_7_days: int
    completion_rate: float


class DashboardAnalytics(BaseModel):
    summary: AnalyticsSummary
    status_distribution: StatusDistribution
    priority_distribution: PriorityDistribution
    subject_workload: list[SubjectWorkload]
    weekly_completion: list[TrendPoint]
    study_insights: StudyInsight


class ProcrastinationBySubject(BaseModel):
    subject_id: int
    name: str
    color: str
    avg_delay: float
    overdue_pct: float
    total_tasks: int
    completed_tasks: int


class ProcrastinationByPriority(BaseModel):
    priority: str
    avg_delay: float
    overdue_pct: float


class DelayTrendPoint(BaseModel):
    week_start: str
    label: str
    avg_delay: float
    task_count: int


class HeatmapCell(BaseModel):
    day: int
    hour: int
    count: int


class ProcrastinationAnalytics(BaseModel):
    procrastination_score: float
    productivity_level: str
    avg_delay_days: float
    overdue_rate: float
    avg_postpone_count: float
    by_subject: list[ProcrastinationBySubject]
    by_priority: list[ProcrastinationByPriority]
    weekly_delay_trend: list[DelayTrendPoint]
    heatmap: list[HeatmapCell]
    recommendations: list[str]
    most_avoided_subjects: list[str]
