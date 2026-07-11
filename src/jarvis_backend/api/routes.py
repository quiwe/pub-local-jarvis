from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from jarvis_backend.orchestrator import OrchestrationService

from .schemas import (
    BarrageRequest,
    BarrageResponse,
    CommandRequest,
    CommandResponse,
    CourseResponse,
    CourseStartRequest,
    EventMessage,
    HealthResponse,
    MemoryClearRequest,
    MemoryClearResponse,
    MemoryStatusResponse,
    MemorySummaryResponse,
    SceneObservation,
    SceneResponse,
)


async def authorize(request: Request, authorization: str | None = Header(default=None)) -> None:
    expected = request.app.state.orchestrator.settings.server.bearer_token
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bearer token")


router = APIRouter(prefix="/api/v1", dependencies=[Depends(authorize)])


def service(request: Request) -> OrchestrationService:
    return request.app.state.orchestrator


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    orchestrator = service(request)
    state = orchestrator.lifecycle.snapshot.state
    return HealthResponse(
        status="ok" if state == "ready" else "degraded",
        lifecycle=state,
        native_connected=orchestrator.native_connected,
    )


@router.post("/commands", response_model=CommandResponse)
async def command(body: CommandRequest, request: Request) -> CommandResponse:
    result = await service(request).command(body.command, body.arguments)
    return CommandResponse(accepted=True, result=result)


@router.post("/scene/observations", response_model=SceneResponse)
async def scene(body: SceneObservation, request: Request) -> SceneResponse:
    orchestrator = service(request)
    changed = await orchestrator.observe_scene(body.score)
    return SceneResponse(active=orchestrator.scene.active, changed=changed)


@router.post("/barrage", response_model=BarrageResponse)
async def barrage(body: BarrageRequest, request: Request) -> BarrageResponse:
    decision = await service(request).submit_barrage(
        body.id, body.text, body.created_at, body.priority
    )
    return BarrageResponse(decision=decision)


@router.get("/memory/status", response_model=MemoryStatusResponse)
async def memory_status(request: Request) -> MemoryStatusResponse:
    return MemoryStatusResponse.model_validate(await service(request).memory_status())


@router.post("/memory/summarize", response_model=MemorySummaryResponse)
async def memory_summarize(request: Request) -> MemorySummaryResponse:
    return MemorySummaryResponse(summary=await service(request).summarize_memory())


@router.post("/memory/clear", response_model=MemoryClearResponse)
async def memory_clear(body: MemoryClearRequest, request: Request) -> MemoryClearResponse:
    if not body.confirm:
        raise HTTPException(status.HTTP_409_CONFLICT, "memory clear requires confirmation")
    await service(request).clear_memory()
    return MemoryClearResponse(cleared=True)


def course_response(state: object) -> CourseResponse:
    return CourseResponse.model_validate(state, from_attributes=True)


@router.post("/courses/start", response_model=CourseResponse, status_code=status.HTTP_201_CREATED)
async def course_start(body: CourseStartRequest, request: Request) -> CourseResponse:
    try:
        state = await service(request).start_course(body.title, body.session_id)
    except FileExistsError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "course already exists") from exc
    return course_response(state)


@router.post("/courses/{session_id}/finish", response_model=CourseResponse)
async def course_finish(session_id: str, request: Request) -> CourseResponse:
    try:
        state = await service(request).finish_course(session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "course not found") from exc
    return course_response(state)


@router.get("/courses", response_model=list[CourseResponse])
async def courses(request: Request) -> list[CourseResponse]:
    return [course_response(item) for item in await service(request).list_courses()]


@router.get("/courses/{session_id}", response_model=CourseResponse)
async def course(session_id: str, request: Request) -> CourseResponse:
    try:
        state = await service(request).get_course(session_id)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "course not found") from exc
    return course_response(state)


@router.get("/events", response_model=list[EventMessage])
async def events(request: Request, topic: str | None = None) -> list[EventMessage]:
    history = service(request).events.history(topic)
    return [EventMessage.model_validate(event, from_attributes=True) for event in history]
