from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import models, schemas, services
from .database import Base, engine, get_db


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

@asynccontextmanager
async def lifespan(_app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="Zejora API",
    description="Academic productivity and coursework planning for students.",
    version="1.0.0",
    lifespan=lifespan,
)


def subject_or_404(db: Session, subject_id: int) -> models.Subject:
    subject = db.get(models.Subject, subject_id)
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found")
    return subject


def task_or_404(db: Session, task_id: int) -> models.Task:
    task = db.scalar(
        select(models.Task)
        .where(models.Task.id == task_id)
        .options(selectinload(models.Task.subject))
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


def subject_response(subject: models.Subject, task_count: int = 0) -> schemas.SubjectRead:
    return schemas.SubjectRead(
        id=subject.id,
        name=subject.name,
        color=subject.color,
        task_count=task_count,
        created_at=services.utc_aware(subject.created_at),
        updated_at=services.utc_aware(subject.updated_at),
    )


def commit_or_duplicate(db: Session, message: str):
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=message) from exc


@app.get("/api/health")
def health():
    return {"status": "healthy", "product": "Zejora"}


@app.get("/api/subjects", response_model=list[schemas.SubjectRead])
def list_subjects(db: Session = Depends(get_db)):
    rows = db.execute(
        select(models.Subject, func.count(models.Task.id))
        .outerjoin(models.Task)
        .group_by(models.Subject.id)
        .order_by(func.lower(models.Subject.name))
    ).all()
    return [subject_response(subject, task_count) for subject, task_count in rows]


@app.post(
    "/api/subjects", response_model=schemas.SubjectRead, status_code=status.HTTP_201_CREATED
)
def create_subject(payload: schemas.SubjectCreate, db: Session = Depends(get_db)):
    duplicate = db.scalar(
        select(models.Subject).where(func.lower(models.Subject.name) == payload.name.lower())
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="A subject with this name already exists")
    subject = models.Subject(**payload.model_dump())
    db.add(subject)
    commit_or_duplicate(db, "A subject with this name already exists")
    db.refresh(subject)
    return subject_response(subject)


@app.get("/api/subjects/{subject_id}", response_model=schemas.SubjectRead)
def get_subject(subject_id: int, db: Session = Depends(get_db)):
    subject = subject_or_404(db, subject_id)
    task_count = db.scalar(
        select(func.count(models.Task.id)).where(models.Task.subject_id == subject_id)
    )
    return subject_response(subject, task_count or 0)


@app.patch("/api/subjects/{subject_id}", response_model=schemas.SubjectRead)
def update_subject(
    subject_id: int, payload: schemas.SubjectUpdate, db: Session = Depends(get_db)
):
    subject = subject_or_404(db, subject_id)
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        duplicate = db.scalar(
            select(models.Subject).where(
                func.lower(models.Subject.name) == updates["name"].lower(),
                models.Subject.id != subject_id,
            )
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="A subject with this name already exists")
    for field, value in updates.items():
        setattr(subject, field, value)
    commit_or_duplicate(db, "A subject with this name already exists")
    db.refresh(subject)
    task_count = db.scalar(
        select(func.count(models.Task.id)).where(models.Task.subject_id == subject_id)
    )
    return subject_response(subject, task_count or 0)


@app.delete("/api/subjects/{subject_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subject(
    subject_id: int,
    cascade: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    subject = subject_or_404(db, subject_id)
    task_count = db.scalar(
        select(func.count(models.Task.id)).where(models.Task.subject_id == subject_id)
    ) or 0
    if task_count and not cascade:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This subject still contains tasks",
                "task_count": task_count,
                "requires_cascade": True,
            },
        )
    db.delete(subject)
    db.commit()


@app.get("/api/tasks", response_model=list[schemas.TaskRead])
def list_tasks(
    subject_id: int | None = None,
    completed: bool | None = None,
    priority: str | None = None,
    search: str | None = None,
    sort_by: str = Query(default="due_at", pattern="^(due_at|priority|created_at|title)$"),
    sort_dir: str = Query(default="asc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_db),
):
    query = select(models.Task).options(selectinload(models.Task.subject))
    if subject_id is not None:
        query = query.where(models.Task.subject_id == subject_id)
    if completed is not None:
        query = query.where(models.Task.completed == completed)
    if priority is not None:
        query = query.where(models.Task.priority == priority)
    if search:
        like = f"%{search}%"
        query = query.where(models.Task.title.ilike(like))
    sort_col = getattr(models.Task, sort_by, models.Task.due_at)
    query = query.order_by(sort_col.desc() if sort_dir == "desc" else sort_col.asc())
    return [services.task_to_read(task) for task in db.scalars(query).all()]


def due_window_tasks(start: datetime, end: datetime, db: Session) -> list[schemas.TaskRead]:
    tasks = db.scalars(
        select(models.Task)
        .where(models.Task.due_at >= start, models.Task.due_at < end)
        .options(selectinload(models.Task.subject))
        .order_by(models.Task.due_at)
    ).all()
    return [services.task_to_read(task) for task in tasks]


@app.get("/api/tasks/due/today", response_model=list[schemas.TaskRead])
def tasks_due_today(
    timezone: str = Query(default="UTC"), db: Session = Depends(get_db)
):
    zone = services.get_timezone(timezone)
    today = datetime.now(zone).date()
    start, end = services.local_day_window(today, zone)
    return due_window_tasks(start, end, db)


@app.get("/api/tasks/due/upcoming", response_model=list[schemas.TaskRead])
def tasks_due_upcoming(
    timezone: str = Query(default="UTC"), db: Session = Depends(get_db)
):
    zone = services.get_timezone(timezone)
    today = datetime.now(zone).date()
    start, _ = services.local_day_window(today + timedelta(days=1), zone)
    end, _ = services.local_day_window(today + timedelta(days=8), zone)
    return due_window_tasks(start, end, db)


@app.get("/api/tasks/due/overdue", response_model=list[schemas.TaskRead])
def tasks_overdue(db: Session = Depends(get_db)):
    now = services.utc_naive(datetime.now(UTC))
    tasks = db.scalars(
        select(models.Task)
        .where(models.Task.completed.is_(False), models.Task.due_at < now)
        .options(selectinload(models.Task.subject))
        .order_by(models.Task.due_at)
    ).all()
    return [services.task_to_read(task) for task in tasks]


@app.post("/api/tasks", response_model=schemas.TaskRead, status_code=status.HTTP_201_CREATED)
def create_task(payload: schemas.TaskCreate, db: Session = Depends(get_db)):
    subject_or_404(db, payload.subject_id)
    data = payload.model_dump()
    data["due_at"] = services.utc_naive(data["due_at"])
    if data["completed"]:
        completed_at = services.utc_naive(datetime.now(UTC))
        data["completed_at"] = completed_at
        delay_secs = (completed_at - data["due_at"]).total_seconds()
        data["delay_days"] = round(max(0.0, delay_secs / 86400), 4)
    task = models.Task(**data)
    db.add(task)
    db.commit()
    return services.task_to_read(task_or_404(db, task.id))


@app.get("/api/tasks/{task_id}", response_model=schemas.TaskRead)
def get_task(task_id: int, db: Session = Depends(get_db)):
    return services.task_to_read(task_or_404(db, task_id))


@app.patch("/api/tasks/{task_id}", response_model=schemas.TaskRead)
def update_task(task_id: int, payload: schemas.TaskUpdate, db: Session = Depends(get_db)):
    task = task_or_404(db, task_id)
    updates = payload.model_dump(exclude_unset=True)
    if "subject_id" in updates:
        subject_or_404(db, updates["subject_id"])
    if "due_at" in updates:
        updates["due_at"] = services.utc_naive(updates["due_at"])
    if "completed" in updates and updates["completed"] != task.completed:
        if updates["completed"]:
            completed_at = services.utc_naive(datetime.now(UTC))
            updates["completed_at"] = completed_at
            delay_secs = (completed_at - task.due_at).total_seconds()
            updates["delay_days"] = round(max(0.0, delay_secs / 86400), 4)
        else:
            updates["completed_at"] = None
            updates["delay_days"] = None
    for field, value in updates.items():
        setattr(task, field, value)
    db.commit()
    return services.task_to_read(task_or_404(db, task_id))


@app.delete("/api/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: int, db: Session = Depends(get_db)):
    task = task_or_404(db, task_id)
    db.delete(task)
    db.commit()


@app.get("/api/analytics/dashboard", response_model=schemas.DashboardAnalytics)
def dashboard_analytics(
    timezone: str = Query(default="UTC"), db: Session = Depends(get_db)
):
    zone = services.get_timezone(timezone)
    now_aware = datetime.now(UTC)
    now = services.utc_naive(now_aware)
    tasks = db.scalars(
        select(models.Task).options(selectinload(models.Task.subject))
    ).all()
    subjects = db.scalars(select(models.Subject).order_by(func.lower(models.Subject.name))).all()

    completed = sum(task.completed for task in tasks)
    overdue = sum(not task.completed and task.due_at < now for task in tasks)
    urgent = sum(
        not task.completed and now <= task.due_at <= now + timedelta(hours=24)
        for task in tasks
    )
    pending = len(tasks) - completed - overdue

    local_today = datetime.now(zone).date()
    today_start, today_end = services.local_day_window(local_today, zone)
    next_start, _ = services.local_day_window(local_today + timedelta(days=1), zone)
    next_end, _ = services.local_day_window(local_today + timedelta(days=8), zone)
    due_today = sum(today_start <= task.due_at < today_end for task in tasks)
    due_next_7_days = sum(next_start <= task.due_at < next_end for task in tasks)

    # Priority distribution
    pri_low = sum(task.priority == "low" for task in tasks)
    pri_medium = sum(task.priority == "medium" for task in tasks)
    pri_high = sum(task.priority == "high" for task in tasks)

    workloads = []
    for subject in subjects:
        count = sum(task.subject_id == subject.id for task in tasks)
        workloads.append(
            schemas.SubjectWorkload(
                subject_id=subject.id,
                name=subject.name,
                color=subject.color,
                task_count=count,
            )
        )

    current_week_start = local_today - timedelta(days=local_today.weekday())
    first_week_start = current_week_start - timedelta(weeks=7)
    weekly = []
    tasks_this_week = 0
    for offset in range(8):
        week_start = first_week_start + timedelta(weeks=offset)
        week_end = week_start + timedelta(days=7)
        count = 0
        for task in tasks:
            if not task.completed_at:
                continue
            local_completed = services.utc_aware(task.completed_at).astimezone(zone)
            if week_start <= local_completed.date() < week_end:
                count += 1
        weekly.append(
            schemas.TrendPoint(
                week_start=week_start.isoformat(),
                label=week_start.strftime("%b %d"),
                completed=count,
            )
        )
        if week_start == current_week_start:
            tasks_this_week = count

    completion_rate = round((completed / len(tasks) * 100) if tasks else 0, 1)
    overdue_rate = round((overdue / len(tasks) * 100) if tasks else 0, 1)
    productivity_score = round(max(0, min(100, completion_rate - overdue_rate * 1.5)), 1)

    return schemas.DashboardAnalytics(
        summary=schemas.AnalyticsSummary(
            total=len(tasks),
            completed=completed,
            pending=pending,
            overdue=overdue,
            urgent=urgent,
            due_today=due_today,
            due_next_7_days=due_next_7_days,
            completion_rate=completion_rate,
        ),
        status_distribution=schemas.StatusDistribution(
            completed=completed, pending=pending, overdue=overdue
        ),
        priority_distribution=schemas.PriorityDistribution(
            low=pri_low, medium=pri_medium, high=pri_high
        ),
        subject_workload=workloads,
        weekly_completion=weekly,
        study_insights=schemas.StudyInsight(
            productivity_score=productivity_score,
            tasks_this_week=tasks_this_week,
        ),
    )


@app.patch("/api/tasks/{task_id}/postpone", response_model=schemas.TaskRead)
def postpone_task(
    task_id: int, payload: schemas.PostponePayload, db: Session = Depends(get_db)
):
    task = task_or_404(db, task_id)
    if task.completed:
        raise HTTPException(status_code=400, detail="Cannot postpone a completed task")
    task.due_at = task.due_at + timedelta(days=payload.days)
    task.postpone_count = (task.postpone_count or 0) + 1
    db.commit()
    return services.task_to_read(task_or_404(db, task_id))


@app.get("/api/analytics/procrastination", response_model=schemas.ProcrastinationAnalytics)
def procrastination_analytics(db: Session = Depends(get_db)):
    from datetime import date as date_type
    tasks = db.scalars(
        select(models.Task).options(selectinload(models.Task.subject))
    ).all()
    subjects = db.scalars(select(models.Subject).order_by(func.lower(models.Subject.name))).all()

    now = services.utc_naive(datetime.now(UTC))
    total = len(tasks)
    completed_tasks = [t for t in tasks if t.completed and t.completed_at]

    delays = [max(0.0, (t.completed_at - t.due_at).total_seconds() / 86400) for t in completed_tasks]
    avg_delay = round(sum(delays) / len(delays), 2) if delays else 0.0
    overdue_count = sum(1 for t in tasks if not t.completed and t.due_at < now)
    overdue_rate = round(overdue_count / total * 100, 1) if total else 0.0
    avg_postpone = round(sum(t.postpone_count for t in tasks) / total, 2) if total else 0.0

    raw_score = 100 - avg_delay * 8 - overdue_rate * 0.8 - avg_postpone * 5
    score = round(max(0.0, min(100.0, raw_score)), 1)
    if score >= 85:
        level = "Excellent"
    elif score >= 70:
        level = "Good"
    elif score >= 50:
        level = "Moderate"
    elif score >= 30:
        level = "Serious"
    else:
        level = "Chronic Procrastinator"

    by_subject = []
    most_avoided = []
    for subj in subjects:
        st = [t for t in tasks if t.subject_id == subj.id]
        sc = [t for t in st if t.completed and t.completed_at]
        sd = [max(0.0, (t.completed_at - t.due_at).total_seconds() / 86400) for t in sc]
        so = sum(1 for t in st if not t.completed and t.due_at < now)
        s_avg = round(sum(sd) / len(sd), 2) if sd else 0.0
        s_pct = round(so / len(st) * 100, 1) if st else 0.0
        by_subject.append(schemas.ProcrastinationBySubject(
            subject_id=subj.id, name=subj.name, color=subj.color,
            avg_delay=s_avg, overdue_pct=s_pct,
            total_tasks=len(st), completed_tasks=len(sc),
        ))
        if s_pct > 40 or s_avg > 2:
            most_avoided.append(subj.name)

    by_priority = []
    for pri in ["low", "medium", "high"]:
        pt = [t for t in tasks if t.priority == pri]
        pc = [t for t in pt if t.completed and t.completed_at]
        pd = [max(0.0, (t.completed_at - t.due_at).total_seconds() / 86400) for t in pc]
        po = sum(1 for t in pt if not t.completed and t.due_at < now)
        by_priority.append(schemas.ProcrastinationByPriority(
            priority=pri,
            avg_delay=round(sum(pd) / len(pd), 2) if pd else 0.0,
            overdue_pct=round(po / len(pt) * 100, 1) if pt else 0.0,
        ))

    today = datetime.now(UTC).date()
    current_week_start = today - timedelta(days=today.weekday())
    first_week_start = current_week_start - timedelta(weeks=7)
    weekly_delay_trend = []
    for offset in range(8):
        ws = first_week_start + timedelta(weeks=offset)
        we = ws + timedelta(days=7)
        wc = [
            t for t in completed_tasks
            if t.completed_at and ws <= services.utc_aware(t.completed_at).date() < we
        ]
        wd = [max(0.0, (t.completed_at - t.due_at).total_seconds() / 86400) for t in wc]
        weekly_delay_trend.append(schemas.DelayTrendPoint(
            week_start=ws.isoformat(),
            label=ws.strftime("%b %d"),
            avg_delay=round(sum(wd) / len(wd), 2) if wd else 0.0,
            task_count=len(wc),
        ))

    heatmap_counts: dict[tuple[int, int], int] = {}
    for t in completed_tasks:
        dt = services.utc_aware(t.completed_at)
        key = (dt.weekday(), dt.hour)
        heatmap_counts[key] = heatmap_counts.get(key, 0) + 1
    heatmap = [
        schemas.HeatmapCell(day=d, hour=h, count=c)
        for (d, h), c in heatmap_counts.items()
    ]

    recs: list[str] = []
    if avg_delay > 2:
        recs.append(f"You complete tasks an average of {avg_delay:.1f} days late. Try breaking assignments into smaller steps and starting earlier.")
    if overdue_rate > 30:
        recs.append(f"{overdue_rate}% of your tasks are overdue. Set personal deadlines 2–3 days ahead of the real one.")
    if avg_postpone > 1:
        recs.append(f"Tasks are postponed on average {avg_postpone:.1f} times. Enable browser reminders to reduce rescheduling.")
    if most_avoided:
        recs.append(f"You tend to delay work in: {', '.join(most_avoided[:3])}. Schedule these subjects during your peak productivity hours.")
    high_postpone = [t for t in tasks if not t.completed and t.postpone_count >= 3]
    if high_postpone:
        titles = ", ".join(t.title for t in high_postpone[:2])
        recs.append(f"Some tasks have been postponed 3+ times ({titles}). Consider breaking them into smaller subtasks.")
    if not recs:
        recs.append("Excellent work! You are consistently meeting your deadlines. Keep up the great habits.")

    return schemas.ProcrastinationAnalytics(
        procrastination_score=score,
        productivity_level=level,
        avg_delay_days=avg_delay,
        overdue_rate=overdue_rate,
        avg_postpone_count=avg_postpone,
        by_subject=by_subject,
        by_priority=by_priority,
        weekly_delay_trend=weekly_delay_trend,
        heatmap=heatmap,
        recommendations=recs,
        most_avoided_subjects=most_avoided[:3],
    )


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def landing_page():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/dashboard", include_in_schema=False)
def dashboard_page():
    return FileResponse(STATIC_DIR / "dashboard.html")
