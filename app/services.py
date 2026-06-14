from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from . import models, schemas


def utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)


def utc_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def get_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown timezone: {name}") from exc


def local_day_window(day: date, zone: ZoneInfo) -> tuple[datetime, datetime]:
    local_start = datetime.combine(day, time.min, tzinfo=zone)
    local_end = local_start + timedelta(days=1)
    return utc_naive(local_start), utc_naive(local_end)


def task_flags(task: models.Task, now: datetime | None = None) -> tuple[str, bool, bool]:
    current = utc_naive(now or datetime.now(UTC))
    if task.completed:
        return "completed", False, False
    is_overdue = task.due_at < current
    is_urgent = not is_overdue and task.due_at <= current + timedelta(hours=24)
    if is_overdue:
        return "overdue", False, True
    if is_urgent:
        return "urgent", True, False
    return "pending", False, False


def task_to_read(task: models.Task, now: datetime | None = None) -> schemas.TaskRead:
    state, is_urgent, is_overdue = task_flags(task, now)
    return schemas.TaskRead(
        id=task.id,
        title=task.title,
        description=task.description,
        subject_id=task.subject_id,
        due_at=utc_aware(task.due_at),
        priority=task.priority,
        estimated_hours=task.estimated_hours,
        completed=task.completed,
        completed_at=utc_aware(task.completed_at),
        delay_days=task.delay_days,
        postpone_count=task.postpone_count,
        created_at=utc_aware(task.created_at),
        updated_at=utc_aware(task.updated_at),
        state=state,
        is_urgent=is_urgent,
        is_overdue=is_overdue,
        subject=schemas.TaskSubject.model_validate(task.subject),
    )

