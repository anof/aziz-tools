"use client"

import { useState, useRef, useEffect, type PointerEvent } from "react"
import { Eraser, Menu, Plus, Trash2, Edit } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// A type for a single point on the canvas
type Point = {
  x: number
  y: number
}

// Each line is now an object with a unique ID and its points
type Line = {
  id: number
  points: Point[]
}

// Type for saved canvas state
type SavedCanvas = {
  id: string
  name: string
  timestamp: number
  lines: Line[]
  pan: Point
  scale: number
}

// Helper to calculate distance between two points
const getDistance = (p1: Point, p2: Point) => {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y)
}

// Helper to generate a unique ID
const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2)

// Helper to format timestamp
const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp)
  return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

const MIN_SCALE = 1e-6
const MAX_SCALE = 1e6
const SAVES_KEY = "infinite-canvas-saves"
const ACTIVE_KEY = "infinite-canvas-active"

const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

const formatZoom = (value: number) => {
  if (value >= 1000 || value < 0.01) {
    return value.toExponential(1).replace("e+", "e") + "×"
  }
  const rounded =
    value >= 10 ? Math.round(value) : value >= 1 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100
  return rounded + "×"
}

export default function InfiniteCanvas() {
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [lines, setLines] = useState<Line[]>([])
  const [isErasing, setIsErasing] = useState(false)
  const [currentCanvasId, setCurrentCanvasId] = useState<string>("")
  const [savedCanvases, setSavedCanvases] = useState<SavedCanvas[]>([])

  const [editingCanvasId, setEditingCanvasId] = useState<string>("")
  const [editingName, setEditingName] = useState("")
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [canvasToDelete, setCanvasToDelete] = useState<SavedCanvas | null>(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [showHint, setShowHint] = useState(true)

  const actionRef = useRef<"drawing" | "erasing" | "panning" | "idle">("idle")
  const lineIdCounter = useRef(0)
  const gestureStartRef = useRef<{ pan: Point; scale: number; midpoint: Point; distance: number } | null>(null)
  const activePointers = useRef(new Map<number, Point>())
  const erasedThisStrokeRef = useRef(new Set<number>())
  const saveTimeoutRef = useRef<NodeJS.Timeout>()
  const activeLineIdRef = useRef<number | null>(null)
  const gestureLockedRef = useRef(false)
  const canvasRef = useRef<HTMLElement | null>(null)
  const panRef = useRef(pan)
  const scaleRef = useRef(scale)

  // Load saved canvases from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(SAVES_KEY)
    if (saved) {
      try {
        const parsedSaves = JSON.parse(saved) as SavedCanvas[]
        setSavedCanvases(parsedSaves)

        // Restore the canvas that was active when the page was closed.
        if (parsedSaves.length > 0) {
          const activeId = localStorage.getItem(ACTIVE_KEY)
          const chosen =
            parsedSaves.find((canvas) => canvas.id === activeId) ||
            [...parsedSaves].sort((a, b) => b.timestamp - a.timestamp)[0]

          localStorage.setItem(ACTIVE_KEY, chosen.id)
          setCurrentCanvasId(chosen.id)
          setLines(chosen.lines)
          setPan(chosen.pan)
          setScale(chosen.scale)
          lineIdCounter.current = chosen.lines.reduce((max, line) => Math.max(max, line.id), -1) + 1
        } else {
          // Create first canvas
          createNewCanvas(false)
        }
      } catch (error) {
        console.error("Failed to load saved canvases:", error)
        createNewCanvas(false)
      }
    } else {
      createNewCanvas(false)
    }
  }, [])

  // Auto-save current canvas when lines, pan, or scale change
  useEffect(() => {
    if (!currentCanvasId) return

    // Debounce saves to avoid excessive localStorage writes
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      saveCurrentCanvas()
    }, 500)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [lines, pan, scale, currentCanvasId])

  useEffect(() => {
    const timer = setTimeout(() => setShowHint(false), 9000)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    panRef.current = pan
  }, [pan])

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  useEffect(() => {
    const element = canvasRef.current
    if (!element) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const currentScale = scaleRef.current
      const currentPan = panRef.current

      if (event.ctrlKey || event.metaKey) {
        // Native listener so the browser's own zoom cannot win.
        const nextScale = clampScale(currentScale * Math.exp(-event.deltaY * 0.0025))
        const rect = element.getBoundingClientRect()
        const pointerX = event.clientX - rect.left
        const pointerY = event.clientY - rect.top
        const ratio = nextScale / currentScale

        setScale(nextScale)
        setPan({
          x: pointerX - (pointerX - currentPan.x) * ratio,
          y: pointerY - (pointerY - currentPan.y) * ratio,
        })
      } else {
        setPan((prevPan) => ({ x: prevPan.x - event.deltaX, y: prevPan.y - event.deltaY }))
      }
    }

    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [])

  const saveCurrentCanvas = (): SavedCanvas[] => {
    if (!currentCanvasId) return savedCanvases

    const existing = savedCanvases.find((c) => c.id === currentCanvasId)
    const currentCanvas: SavedCanvas = {
      id: currentCanvasId,
      name: existing?.name || `Drawing ${formatTimestamp(Date.now())}`,
      timestamp: Date.now(),
      lines,
      pan,
      scale,
    }
    const updated = savedCanvases.some((c) => c.id === currentCanvasId)
      ? savedCanvases.map((c) => (c.id === currentCanvasId ? currentCanvas : c))
      : [currentCanvas, ...savedCanvases]

    localStorage.setItem(SAVES_KEY, JSON.stringify(updated))
    setSavedCanvases(updated)
    return updated
  }

  const resetInteraction = () => {
    actionRef.current = "idle"
    gestureStartRef.current = null
    activePointers.current.clear()
    gestureLockedRef.current = false
    activeLineIdRef.current = null
    erasedThisStrokeRef.current.clear()
  }

  const createNewCanvas = (closeMenu = true, skipSave = false, base?: SavedCanvas[]) => {
    const persisted = base ?? (skipSave ? savedCanvases : saveCurrentCanvas())

    const newId = generateId()
    const newCanvas: SavedCanvas = {
      id: newId,
      name: `Drawing ${formatTimestamp(Date.now())}`,
      timestamp: Date.now(),
      lines: [],
      pan: { x: 0, y: 0 },
      scale: 1,
    }

    setCurrentCanvasId(newId)
    setLines([])
    setPan({ x: 0, y: 0 })
    setScale(1)
    lineIdCounter.current = 0
    resetInteraction()

    const updated = [newCanvas, ...persisted.filter((c) => c.id !== newCanvas.id)]
    localStorage.setItem(SAVES_KEY, JSON.stringify(updated))
    localStorage.setItem(ACTIVE_KEY, newId)
    setSavedCanvases(updated)
    if (closeMenu) setIsMenuOpen(false)
  }

  const loadCanvas = (canvas: SavedCanvas, closeMenu = true, skipSave = false, base?: SavedCanvas[]) => {
    const persisted = base ?? (skipSave ? savedCanvases : saveCurrentCanvas())
    const now = Date.now()
    const updated = persisted.some((c) => c.id === canvas.id)
      ? persisted.map((c) => (c.id === canvas.id ? { ...c, timestamp: now } : c))
      : [{ ...canvas, timestamp: now }, ...persisted]

    localStorage.setItem(SAVES_KEY, JSON.stringify(updated))
    localStorage.setItem(ACTIVE_KEY, canvas.id)
    setSavedCanvases(updated)

    setCurrentCanvasId(canvas.id)
    setLines(canvas.lines)
    setPan(canvas.pan)
    setScale(canvas.scale)
    resetInteraction()

    // Update line counter to avoid ID conflicts
    const maxId = canvas.lines.reduce((max, line) => Math.max(max, line.id), -1)
    lineIdCounter.current = maxId + 1
    if (closeMenu) setIsMenuOpen(false)
  }

  const confirmDeleteCanvas = (canvas: SavedCanvas) => {
    setCanvasToDelete(canvas)
    setDeleteConfirmOpen(true)
    setIsMenuOpen(false) // Close the menu before opening the dialog
  }

  const deleteCanvas = (canvasId: string) => {
    const updated = savedCanvases.filter((canvas) => canvas.id !== canvasId)
    localStorage.setItem(SAVES_KEY, JSON.stringify(updated))
    setSavedCanvases(updated)

    // If we deleted the current canvas, load another one or create new
    if (canvasId === currentCanvasId) {
      if (updated.length > 0) {
        const mostRecent = [...updated].sort((a, b) => b.timestamp - a.timestamp)[0]
        loadCanvas(mostRecent, false, true, updated)
      } else {
        createNewCanvas(false, true, updated)
      }
    }
    setDeleteConfirmOpen(false)
    setCanvasToDelete(null)
  }

  const cancelDelete = () => {
    setDeleteConfirmOpen(false)
    setCanvasToDelete(null)
  }

  const renameCanvas = (canvasId: string, newName: string) => {
    const trimmed = newName.trim()
    if (!trimmed) {
      cancelEditing()
      return
    }

    const updated = savedCanvases.map((canvas) =>
      canvas.id === canvasId ? { ...canvas, name: trimmed } : canvas,
    )
    localStorage.setItem(SAVES_KEY, JSON.stringify(updated))
    setSavedCanvases(updated)
    setEditingCanvasId("")
    setEditingName("")
  }

  const startEditing = (canvas: SavedCanvas) => {
    setEditingCanvasId(canvas.id)
    setEditingName(canvas.name)
  }

  const cancelEditing = () => {
    setEditingCanvasId("")
    setEditingName("")
  }

  const getRelativePosition = (clientX: number, clientY: number): Point => {
    return { x: (clientX - pan.x) / scale, y: (clientY - pan.y) / scale }
  }

  const startLine = (clientX: number, clientY: number) => {
    const newPoint = getRelativePosition(clientX, clientY)
    const id = lineIdCounter.current++
    activeLineIdRef.current = id
    actionRef.current = "drawing"
    setLines((prevLines) => [...prevLines, { id, points: [newPoint] }])
  }

  const cancelActiveStroke = () => {
    if (actionRef.current === "drawing" && activeLineIdRef.current !== null) {
      const id = activeLineIdRef.current
      setLines((prevLines) => prevLines.filter((line) => line.id !== id))
    }
    activeLineIdRef.current = null
    actionRef.current = "idle"
  }

  const handlePointerDown = (e: PointerEvent) => {
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (e.pointerType === "touch") {
      if (activePointers.current.size >= 2) {
        // A second finger always wins, even if the first one already drew.
        cancelActiveStroke()
        gestureLockedRef.current = true
        actionRef.current = "panning"
        const pointers = Array.from(activePointers.current.values()).slice(0, 2)
        gestureStartRef.current = {
          pan,
          scale,
          midpoint: {
            x: (pointers[0].x + pointers[1].x) / 2,
            y: (pointers[0].y + pointers[1].y) / 2,
          },
          distance: Math.max(1, getDistance(pointers[0], pointers[1])),
        }
        return
      }

      if (gestureLockedRef.current) return

      if (isErasing) {
        actionRef.current = "erasing"
        erasedThisStrokeRef.current.clear()
        eraseAtPoint(e.clientX, e.clientY)
        return
      }

      startLine(e.clientX, e.clientY)
      return
    }

    const isEraserButtonPressed = e.buttons === 2 || e.buttons === 32
    if (isErasing || isEraserButtonPressed) {
      actionRef.current = "erasing"
      erasedThisStrokeRef.current.clear()
      eraseAtPoint(e.clientX, e.clientY)
      return
    }

    if (e.buttons === 1) startLine(e.clientX, e.clientY)
  }

  const eraseAtPoint = (clientX: number, clientY: number) => {
    const eraserPosition = getRelativePosition(clientX, clientY)
    // Eraser radius that scales with zoom level - bigger when zoomed out, smaller when zoomed in
    const eraserRadius = 20 / scale
    const linesToErase = new Set<number>()

    for (const line of lines) {
      if (erasedThisStrokeRef.current.has(line.id)) continue
      for (const point of line.points) {
        const distance = Math.hypot(eraserPosition.x - point.x, eraserPosition.y - point.y)
        if (distance < eraserRadius) {
          linesToErase.add(line.id)
          erasedThisStrokeRef.current.add(line.id)
          break
        }
      }
    }

    if (linesToErase.size > 0) {
      setLines((prevLines) => prevLines.filter((line) => !linesToErase.has(line.id)))
    }
  }

  const handlePointerMove = (e: PointerEvent) => {
    if (activePointers.current.has(e.pointerId)) {
      activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    if (actionRef.current === "panning") {
      if (activePointers.current.size < 2 || !gestureStartRef.current) return

      const pointers = Array.from(activePointers.current.values()).slice(0, 2)
      const currentMidpoint = {
        x: (pointers[0].x + pointers[1].x) / 2,
        y: (pointers[0].y + pointers[1].y) / 2,
      }
      const currentDistance = Math.max(1, getDistance(pointers[0], pointers[1]))
      const { pan: panStart, scale: scaleStart, midpoint: midpointStart, distance: distanceStart } =
        gestureStartRef.current

      const newScale = clampScale(scaleStart * (currentDistance / Math.max(1, distanceStart)))
      const worldX = (midpointStart.x - panStart.x) / scaleStart
      const worldY = (midpointStart.y - panStart.y) / scaleStart

      setScale(newScale)
      setPan({
        x: currentMidpoint.x - worldX * newScale,
        y: currentMidpoint.y - worldY * newScale,
      })
      return
    }

    if (actionRef.current === "erasing") {
      eraseAtPoint(e.clientX, e.clientY)
      return
    }

    if (actionRef.current === "drawing" && activeLineIdRef.current !== null) {
      const newPoint = getRelativePosition(e.clientX, e.clientY)
      const activeId = activeLineIdRef.current
      setLines((prevLines) =>
        prevLines.map((line) =>
          line.id === activeId ? { ...line, points: [...line.points, newPoint] } : line,
        ),
      )
    }
  }

  const handlePointerUp = (e: PointerEvent) => {
    activePointers.current.delete(e.pointerId)

    if (actionRef.current === "panning") {
      if (activePointers.current.size < 2) {
        actionRef.current = "idle"
        gestureStartRef.current = null
        gestureLockedRef.current = activePointers.current.size > 0
      }
      if (activePointers.current.size === 0) gestureLockedRef.current = false
      return
    }

    if (e.pointerType === "touch") {
      if (activePointers.current.size === 0) {
        actionRef.current = "idle"
        activeLineIdRef.current = null
        gestureLockedRef.current = false
      }
      return
    }

    actionRef.current = "idle"
    activeLineIdRef.current = null
    gestureStartRef.current = null
  }

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative select-none">
      {/* Eraser button */}
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "absolute top-[calc(1rem+env(safe-area-inset-top))] left-4 z-10 h-12 w-12 rounded-lg transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
          isErasing
            ? "border border-blue-400/40 bg-blue-500/25 text-blue-300 hover:bg-blue-500/35 active:bg-blue-500/45"
            : "border border-white/10 bg-white/10 text-white hover:bg-white/15 active:bg-white/20",
        )}
        onClick={() => setIsErasing(!isErasing)}
        aria-label={isErasing ? "Disable eraser" : "Enable eraser"}
        data-testid="eraser"
      >
        <Eraser className="h-6 w-6" />
      </Button>

      {/* Current drawing name */}
      <div className="absolute top-[calc(1rem+env(safe-area-inset-top))] left-1/2 z-10 max-w-[54vw] -translate-x-1/2">
        <div
          data-testid="session-name"
          className="truncate rounded-lg border border-gray-700 bg-gray-900/80 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm"
        >
          {savedCanvases.find((c) => c.id === currentCanvasId)?.name || "Untitled Drawing"}
          <span className="text-gray-400"> · {formatZoom(scale)}</span>
        </div>
      </div>

      {/* Drawings menu */}
      <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-[calc(1rem+env(safe-area-inset-top))] right-4 z-10 h-12 w-12 rounded-lg border border-white/10 bg-white/10 text-white hover:bg-white/15 active:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            aria-label="Drawings menu"
            data-testid="session-menu"
          >
            <Menu className="h-6 w-6" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 bg-gray-900 border-gray-700">
          <DropdownMenuItem
            onSelect={() => createNewCanvas()}
            className="text-white hover:bg-gray-800 focus:bg-gray-800"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Drawing
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-gray-700" />
          <div className="max-h-64 overflow-y-auto">
            {savedCanvases.length === 0 ? (
              <div className="px-2 py-1 text-sm text-gray-400">No saved drawings</div>
            ) : (
              savedCanvases
                .sort((a, b) => b.timestamp - a.timestamp)
                .map((canvas) => (
                  <div key={canvas.id} className="flex items-center group">
                    {editingCanvasId === canvas.id ? (
                      <div className="flex-1 px-2 py-1">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onBlur={() => renameCanvas(canvas.id, editingName)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              renameCanvas(canvas.id, editingName)
                            } else if (e.key === "Escape") {
                              cancelEditing()
                            }
                          }}
                          className="w-full bg-gray-800 text-white text-sm px-2 py-1 rounded border border-gray-600 focus:border-blue-500 focus:outline-none"
                          autoFocus
                          onFocus={(e) => e.target.select()}
                        />
                      </div>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => loadCanvas(canvas)}
                        className={cn(
                          "flex-1 text-white hover:bg-gray-800 focus:bg-gray-800 truncate",
                          canvas.id === currentCanvasId && "bg-blue-500/20 text-blue-400",
                        )}
                      >
                        <div className="flex flex-col items-start min-w-0">
                          <span className="text-sm truncate w-full">{canvas.name}</span>
                          <span className="text-xs text-gray-400">{formatTimestamp(canvas.timestamp)}</span>
                        </div>
                      </DropdownMenuItem>
                    )}
                    {editingCanvasId !== canvas.id && (
                      <div className="flex">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            startEditing(canvas)
                          }}
                          className="h-8 w-8 p-0 text-blue-400 hover:text-blue-300 hover:bg-blue-500/20"
                          aria-label={`Rename ${canvas.name}`}
                        >
                          <Edit className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            confirmDeleteCanvas(canvas)
                          }}
                          className="h-8 w-8 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/20"
                          aria-label={`Delete ${canvas.name}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete confirmation modal */}
      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            cancelDelete()
          }
        }}
      >
        <AlertDialogContent className="bg-gray-900 border-gray-700">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Delete Drawing</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-300">
              Are you sure you want to delete "{canvasToDelete?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-gray-800 text-white border-gray-600 hover:bg-gray-700">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => canvasToDelete && deleteCanvas(canvasToDelete.id)}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <main
        ref={canvasRef}
        className={cn(
          "w-full h-full touch-none overscroll-none",
          isErasing ? "cursor-cell" : "cursor-crosshair",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Infinite Canvas"
      >
        <svg className="w-full h-full">
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
            {lines.map((line) => {
              const pointsString = line.points.map((p) => `${p.x},${p.y}`).join(" ")
              // If it's a single point, draw a tiny line with a round cap to make a dot
              const finalPointsString = line.points.length === 1 ? `${pointsString} ${pointsString}` : pointsString

              return (
                <polyline
                  key={line.id}
                  points={finalPointsString}
                  fill="none"
                  stroke="rgb(59 130 246)"
                  strokeWidth={line.points.length === 1 ? 3 : 2}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )
            })}
          </g>
        </svg>
      </main>

      {showHint && (
        <div className="pointer-events-none absolute bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-1/2 z-10 max-w-[92vw] -translate-x-1/2 rounded-full border border-white/10 bg-black/60 px-3 py-2 text-center text-[11px] leading-relaxed text-white/60">
          One finger draws · Two fingers move &amp; zoom · Pinch or Ctrl/⌘ + scroll to zoom
        </div>
      )}
    </div>
  )
}
