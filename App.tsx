import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  GoogleGenAI, 
  LiveServerMessage, 
  Modality, 
  Blob as GenAIBlob,
  FunctionDeclaration,
  Chat
} from "@google/genai";
import { 
  ToolType, 
  CanvasElement, 
  ViewState, 
  ElementType, 
  AIState,
  PathElement,
  ShapeElement,
  LineElement,
  Point,
  TextElement
} from './types';
import { MODEL_NAMES, whiteboardTools, SYSTEM_INSTRUCTION } from './constants';
import { Toolbar } from './components/Toolbar';
import { SimulationNode } from './components/SimulationNode';
import { TextNode } from './components/TextNode';
import { generateImageContent, generateSimulationCode, generateVectorDrawing } from './services/geminiService';
import { Send, MessageSquare, Loader2 } from 'lucide-react';

// --- Utils ---
const encodeAudio = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decodeAudio = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));

function resampleTo16k(buffer: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 16000) return buffer;
  const ratio = sampleRate / 16000;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    if (index + 1 < buffer.length) {
      result[i] = buffer[index] * (1 - fraction) + buffer[index + 1] * fraction;
    } else {
      result[i] = buffer[index];
    }
  }
  return result;
}

const decodeAudioData = async (data: Uint8Array, ctx: AudioContext) => {
  const dataInt16 = new Int16Array(data.buffer);
  const buffer = ctx.createBuffer(1, dataInt16.length, 24000);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < channelData.length; i++) {
    channelData[i] = dataInt16[i] / 32768.0;
  }
  return buffer;
};

function createBlob(data: Float32Array): GenAIBlob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return {
    data: encodeAudio(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

const App: React.FC = () => {
  // --- Whiteboard State ---
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  const [currentTool, setTool] = useState<ToolType>(ToolType.PEN);
  const [currentColor, setColor] = useState<string>('#000000');
  const [isFilled, setIsFilled] = useState(false); // Solid vs Transparent

  // History State
  const [history, setHistory] = useState<CanvasElement[][]>([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Interaction State
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null); 
  const [interactionMode, setInteractionMode] = useState<'idle' | 'drawing' | 'moving' | 'resizing' | 'panning' | 'selecting'>('idle');
  
  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionRect, setSelectionRect] = useState<{x:number, y:number, w:number, h:number} | null>(null);

  // Drawing Buffers
  const [currentPath, setCurrentPath] = useState<PathElement | null>(null);
  const [tempElement, setTempElement] = useState<CanvasElement | null>(null);

  // Text Input
  const [textInputPos, setTextInputPos] = useState<Point | null>(null);
  const [inputTextValue, setInputTextValue] = useState("");

  // --- AI State ---
  const [aiState, setAiState] = useState<AIState>({ isConnected: false, isListening: false, modelState: 'idle' });
  const [chatInputText, setChatInputText] = useState("");
  const [isChatProcessing, setIsChatProcessing] = useState(false);

  // Refs
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const requestRef = useRef<number | undefined>(undefined);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  
  // Live API Refs
  const liveSession = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const nextStartTime = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const isConnectingRef = useRef(false);
  const videoIntervalRef = useRef<number | undefined>(undefined);
  
  // Chat API Ref
  const chatSessionRef = useRef<Chat | null>(null);

  // Opt Refs
  const canvasVersion = useRef(0);
  const isDraggingRef = useRef(false);

  useEffect(() => { canvasVersion.current += 1; }, [elements]);
  useEffect(() => { isDraggingRef.current = isDragging; }, [isDragging]);

  // --- Helpers ---
  const pushToHistory = (newElements: CanvasElement[]) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newElements);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setElements(newElements);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setElements(history[historyIndex - 1]);
      setSelectedIds(new Set());
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setElements(history[historyIndex + 1]);
      setSelectedIds(new Set());
    }
  };

  // --- Vision ---
  const getScreenCapture = async (): Promise<string | null> => {
    if (!svgRef.current) return null;
    try {
        const serializer = new XMLSerializer();
        const svgStr = serializer.serializeToString(svgRef.current);
        const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxWidth = 500;
                const scale = Math.min(1, maxWidth / window.innerWidth);
                canvas.width = window.innerWidth * scale;
                canvas.height = window.innerHeight * scale;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }
                ctx.fillStyle = '#f3f4f6';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const base64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
                URL.revokeObjectURL(url);
                resolve(base64);
            };
            img.src = url;
        });
    } catch { return null; }
  };

  // --- Tool Execution ---
  const executeTools = async (functionCalls: any[]) => {
    const responses = [];
    let addedElements: CanvasElement[] = [];
    let shouldClear = false;

    for (const fc of functionCalls) {
        const { name, args } = fc;
        let result = { result: "ok" };
        const id = Date.now().toString() + Math.random();

        try {
            if (name === 'pan_view') {
                // Center view on x,y
                const newX = args.x - (window.innerWidth / view.scale) / 2;
                const newY = args.y - (window.innerHeight / view.scale) / 2;
                setView(v => ({ ...v, x: newX, y: newY }));
                result = { result: "View moved." };

            } else if (name === 'draw_rectangle' || name === 'draw_circle' || name === 'draw_triangle') {
                let type = ElementType.RECT;
                if (name === 'draw_circle') type = ElementType.CIRCLE;
                if (name === 'draw_triangle') type = ElementType.TRIANGLE;
                
                const el: ShapeElement = {
                    id, type: type as any,
                    x: args.x, y: args.y, 
                    width: args.radius ? args.radius * 2 : args.width, 
                    height: args.radius ? args.radius * 2 : args.height,
                    color: args.color,
                    filled: args.filled
                };
                if (name === 'draw_circle') { el.x -= args.radius; el.y -= args.radius; }
                addedElements.push(el);

            } else if (name === 'draw_line') {
                addedElements.push({
                    id, type: ElementType.LINE,
                    x: args.x1, y: args.y1,
                    x2: args.x2, y2: args.y2,
                    color: args.color, strokeWidth: args.strokeWidth || 3, filled: true
                });

            } else if (name === 'draw_path') {
                addedElements.push({
                    id, type: ElementType.PATH,
                    x: 0, y: 0, points: [],
                    pathData: args.pathData,
                    color: args.color, strokeWidth: args.strokeWidth || 3, filled: false
                });

            } else if (name === 'write_text') {
                addedElements.push({
                    id, type: ElementType.TEXT,
                    x: args.x, y: args.y,
                    text: args.text, fontSize: 24, color: args.color || '#000000', filled: true
                });

            } else if (name === 'clear_board') {
                shouldClear = true;
                addedElements = [];

            } else if (name === 'generate_image') {
                const b64 = await generateImageContent(args.prompt, args.size || '1K');
                if (b64) {
                    addedElements.push({
                        id, type: ElementType.IMAGE,
                        x: args.x, y: args.y, width: 300, height: 300,
                        src: b64, color: '#000000'
                    });
                    result = { result: "Image generated." };
                } else result = { result: "Failed." };

            } else if (name === 'generate_simulation') {
                // Now we call Gemini 3 to get the code
                const code = await generateSimulationCode(args.prompt);
                if (code) {
                    addedElements.push({
                        id, type: ElementType.SIMULATION,
                        x: args.x, y: args.y, width: 500, height: 400,
                        code: code, title: args.title, color: '#fff'
                    });
                    result = { result: "Simulation created." };
                } else result = { result: "Failed to generate simulation code." };

            } else if (name === 'generate_vector_drawing') {
                // Call Gemini 3 to get JSON shapes
                const shapes = await generateVectorDrawing(args.prompt);
                if (shapes && Array.isArray(shapes)) {
                    shapes.forEach((s: any) => {
                        // Map JSON shapes to CanvasElements
                        const subId = Date.now().toString() + Math.random();
                        const baseX = args.x + (s.x || 0);
                        const baseY = args.y + (s.y || 0);

                        if (s.type === 'rect' || s.type === 'triangle') {
                             addedElements.push({
                                 id: subId, type: s.type === 'rect' ? ElementType.RECT : ElementType.TRIANGLE,
                                 x: baseX, y: baseY, width: s.width, height: s.height,
                                 color: s.color, filled: s.filled
                             });
                        } else if (s.type === 'circle') {
                             addedElements.push({
                                 id: subId, type: ElementType.CIRCLE,
                                 x: baseX - s.radius, y: baseY - s.radius,
                                 width: s.radius*2, height: s.radius*2,
                                 color: s.color, filled: s.filled
                             });
                        } else if (s.type === 'line') {
                             addedElements.push({
                                 id: subId, type: ElementType.LINE,
                                 x: args.x + s.x1, y: args.y + s.y1,
                                 x2: args.x + s.x2, y2: args.y + s.y2,
                                 color: s.color, strokeWidth: s.strokeWidth, filled: true
                             });
                        } else if (s.type === 'path') {
                             addedElements.push({
                                 id: subId, type: ElementType.PATH,
                                 x: args.x, y: args.y, // Path data assumes local coords, but we might offset?
                                 // Usually pathData is absolute, so we might just assume relative 
                                 // For simplicity, we assume pathData is correct relative to view if transformed, 
                                 // or we just trust the vector generator output.
                                 points: [], pathData: s.pathData,
                                 color: s.color, strokeWidth: s.strokeWidth, filled: false
                             });
                        }
                    });
                    result = { result: "Vector drawing created." };
                } else result = { result: "Failed to generate vector drawing." };
            }

        } catch (e) { console.error(e); result = { result: "Error." }; }
        responses.push({ id: fc.id, name: fc.name, response: result });
    }

    if (shouldClear || addedElements.length > 0) {
        setElements(prev => {
            const next = shouldClear ? [...addedElements] : [...prev, ...addedElements];
            pushToHistory(next);
            return next;
        });
    }
    return responses;
  };

  // --- Interaction Logic ---
  const getPointerPos = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: view.x + (e.clientX - rect.left) / view.scale,
      y: view.y + (e.clientY - rect.top) / view.scale
    };
  };

  const hitTest = (x: number, y: number): CanvasElement | undefined => {
      // Search reverse (top to bottom)
      return elements.slice().reverse().find(el => {
        const padding = 10 / view.scale;
        if (el.type === ElementType.TEXT) return x >= el.x && x <= el.x + 200 && y >= el.y && y <= el.y + 50;
        if (el.type === ElementType.PATH) {
             // Simple box check for path for speed
             if (el.pathData) return Math.abs(el.x - x) < 50 && Math.abs(el.y - y) < 50;
             // Check points
             if (el.points.length) {
                 return el.points.some(p => Math.hypot(p.x - x, p.y - y) < padding);
             }
        }
        if (el.type === ElementType.LINE) {
             // Distance to segment
             const A = x - el.x; const B = y - el.y;
             const C = el.x2 - el.x; const D = el.y2 - el.y;
             const dot = A * C + B * D;
             const lenSq = C * C + D * D;
             let param = -1;
             if (lenSq !== 0) param = dot / lenSq;
             let xx, yy;
             if (param < 0) { xx = el.x; yy = el.y; }
             else if (param > 1) { xx = el.x2; yy = el.y2; }
             else { xx = el.x + param * C; yy = el.y + param * D; }
             const dx = x - xx; const dy = y - yy;
             return Math.hypot(dx, dy) < padding;
        }
        // Shapes/Images/Sims
        if ('width' in el) {
            return x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height;
        }
        return false;
      });
  };

  const deleteSelected = useCallback(() => {
    if (selectedIds.size > 0) {
        const newEls = elements.filter(el => !selectedIds.has(el.id));
        pushToHistory(newEls);
        setSelectedIds(new Set());
    }
  }, [selectedIds, elements]);

  // Keyboard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); handleUndo(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); handleRedo(); }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (document.activeElement?.tagName !== 'TEXTAREA') deleteSelected();
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected]);


  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    (e.target as Element).releasePointerCapture(e.pointerId);
    
    const { x, y } = getPointerPos(e);
    
    // Text Mode
    if (currentTool === ToolType.TEXT) {
        if (textInputPos) finalizeText();
        else { setTextInputPos({ x, y }); setInputTextValue(""); }
        return;
    }
    if (textInputPos) { finalizeText(); return; }

    setDragStart({ x: e.clientX, y: e.clientY }); // Screen coords for drag deltas

    // Pan Mode
    if (currentTool === ToolType.PAN) {
        setInteractionMode('panning');
        return;
    }

    // Select Mode
    if (currentTool === ToolType.SELECT) {
        const hit = hitTest(x, y);
        
        // Handle resizing handle check (simplistic: only if 1 item selected)
        if (selectedIds.size === 1) {
            const id = Array.from(selectedIds)[0];
            const el = elements.find(e => e.id === id);
            if (el && 'width' in el) {
                const handleSize = 15 / view.scale;
                const right = el.x + el.width;
                const bottom = el.y + el.height;
                if (Math.abs(x - right) < handleSize && Math.abs(y - bottom) < handleSize) {
                    setInteractionMode('resizing');
                    return;
                }
            }
        }

        if (hit) {
            setInteractionMode('moving');
            if (e.shiftKey) {
                const newSet = new Set(selectedIds);
                if (newSet.has(hit.id)) newSet.delete(hit.id);
                else newSet.add(hit.id);
                setSelectedIds(newSet);
            } else {
                if (!selectedIds.has(hit.id)) {
                    setSelectedIds(new Set([hit.id]));
                }
            }
        } else {
            // Start Marquee
            setInteractionMode('selecting');
            setSelectionRect({ x, y, w: 0, h: 0 });
            if (!e.shiftKey) setSelectedIds(new Set());
        }
        return;
    }

    // Eraser
    if (currentTool === ToolType.ERASER) {
        setInteractionMode('drawing');
        setIsDragging(true);
        eraseAt(x, y);
        return;
    }

    // Drawing/Shape Modes
    setInteractionMode('drawing');
    const id = Date.now().toString();
    
    if (currentTool === ToolType.PEN) {
        setCurrentPath({ id, type: ElementType.PATH, x: 0, y: 0, points: [{x, y}], color: currentColor, strokeWidth: 3, filled: false });
    } else if (currentTool === ToolType.LINE) {
        setTempElement({ id, type: ElementType.LINE, x, y, x2: x, y2: y, color: currentColor, strokeWidth: 3, filled: true });
    } else if (currentTool === ToolType.RECTANGLE) {
        setTempElement({ id, type: ElementType.RECT, x, y, width: 0, height: 0, color: currentColor, filled: isFilled });
    } else if (currentTool === ToolType.CIRCLE) {
        setTempElement({ id, type: ElementType.CIRCLE, x, y, width: 0, height: 0, color: currentColor, filled: isFilled });
    } else if (currentTool === ToolType.TRIANGLE) {
        setTempElement({ id, type: ElementType.TRIANGLE, x, y, width: 0, height: 0, color: currentColor, filled: isFilled });
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (requestRef.current) return;
    requestRef.current = requestAnimationFrame(() => {
        requestRef.current = undefined;
        const { x, y } = getPointerPos(e);
        const dx = e.movementX / view.scale;
        const dy = e.movementY / view.scale;

        if (interactionMode === 'panning') {
            setView(v => ({ ...v, x: v.x - dx, y: v.y - dy }));
        }
        else if (interactionMode === 'moving') {
            setElements(prev => prev.map(el => {
                if (selectedIds.has(el.id)) {
                    if (el.type === ElementType.LINE) return { ...el, x: el.x + dx, y: el.y + dy, x2: el.x2 + dx, y2: el.y2 + dy };
                    if (el.type === ElementType.PATH && el.points.length) {
                        return { ...el, points: el.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
                    }
                    return { ...el, x: el.x + dx, y: el.y + dy };
                }
                return el;
            }));
        }
        else if (interactionMode === 'resizing' && selectedIds.size === 1) {
            const id = Array.from(selectedIds)[0];
            setElements(prev => prev.map(el => {
                if (el.id === id && 'width' in el) {
                    return { ...el, width: Math.max(10, x - el.x), height: Math.max(10, y - el.y) };
                }
                return el;
            }));
        }
        else if (interactionMode === 'selecting' && selectionRect) {
            setSelectionRect(prev => prev ? { ...prev, w: x - prev.x, h: y - prev.y } : null);
        }
        else if (interactionMode === 'drawing') {
            if (currentTool === ToolType.PEN && currentPath) {
                setCurrentPath(prev => prev ? { ...prev, points: [...prev.points, {x, y}] } : null);
            }
            if (currentTool === ToolType.ERASER) {
                eraseAt(x, y);
            }
            if (tempElement) {
                if (tempElement.type === ElementType.LINE) {
                    setTempElement({ ...tempElement, x2: x, y2: y });
                } else if ('width' in tempElement) {
                    setTempElement(prev => {
                         if (!prev || !('width' in prev)) return prev;
                         const startX = prev.x; 
                         const startY = prev.y; 
                         // Check if we are dragging negative
                         // For simplicity in this version, we just update width/height
                         // Real implementation should flip x/y if width < 0
                         return { ...prev, width: x - startX, height: y - startY };
                    });
                }
            }
        }
    });
  };

  const handlePointerUp = () => {
    if (interactionMode === 'drawing') {
        let newEl = null;
        if (currentPath) newEl = currentPath;
        if (tempElement) {
            // Normalize Geometry if needed
            newEl = {...tempElement};
            if ('width' in newEl) {
                if (newEl.width < 0) { newEl.x += newEl.width; newEl.width = Math.abs(newEl.width); }
                if (newEl.height < 0) { newEl.y += newEl.height; newEl.height = Math.abs(newEl.height); }
            }
        }
        if (newEl) pushToHistory([...elements, newEl]);
    }
    else if (interactionMode === 'selecting' && selectionRect) {
        // Find items in rect
        const rx = selectionRect.w < 0 ? selectionRect.x + selectionRect.w : selectionRect.x;
        const ry = selectionRect.h < 0 ? selectionRect.y + selectionRect.h : selectionRect.y;
        const rw = Math.abs(selectionRect.w);
        const rh = Math.abs(selectionRect.h);
        
        const newSelected = new Set(selectedIds);
        elements.forEach(el => {
            // Center point check for simplicity
            let cx = el.x, cy = el.y;
            if ('width' in el) { cx += el.width/2; cy += el.height/2; }
            if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) {
                newSelected.add(el.id);
            }
        });
        setSelectedIds(newSelected);
    }
    else if (interactionMode === 'moving' || interactionMode === 'resizing') {
        pushToHistory(elements);
    }

    setInteractionMode('idle');
    setDragStart(null);
    setCurrentPath(null);
    setTempElement(null);
    setSelectionRect(null);
    setIsDragging(false);
  };

  // --- Helpers ---
  const eraseAt = (x: number, y: number) => {
    const r = 20 / view.scale;
    const toDel = new Set<string>();
    elements.forEach(el => {
        let hit = false;
        if ('width' in el) {
            const cx = el.x + el.width/2; const cy = el.y + el.height/2;
            hit = Math.hypot(cx - x, cy - y) < r + Math.min(el.width, el.height)/2;
        } else if (el.type === ElementType.TEXT) {
            hit = Math.abs(el.x - x) < r + 50 && Math.abs(el.y - y) < r + 20;
        } else if (el.type === ElementType.PATH && el.points) {
            hit = el.points.some(p => Math.hypot(p.x - x, p.y - y) < r);
        } else if (el.type === ElementType.LINE) {
             const cx = (el.x + el.x2)/2; const cy = (el.y + el.y2)/2;
             hit = Math.hypot(cx - x, cy - y) < r + 20;
        }
        if (hit) toDel.add(el.id);
    });
    if (toDel.size > 0) setElements(prev => prev.filter(e => !toDel.has(e.id)));
  };

  const finalizeText = useCallback(() => {
      if (textInputPos && inputTextValue.trim()) {
          const newEl: TextElement = {
              id: Date.now().toString(), type: ElementType.TEXT,
              x: textInputPos.x, y: textInputPos.y, text: inputTextValue, fontSize: 24, color: currentColor, filled: true
          };
          pushToHistory([...elements, newEl]);
      }
      setTextInputPos(null); setInputTextValue("");
  }, [textInputPos, inputTextValue, elements]);


  // --- Render ---
  const canvasContent = useMemo(() => {
      const renderEl = (el: CanvasElement, selected: boolean) => {
          const opacity = selected ? 0.8 : 1;
          const strokeColor = el.color;
          const fillColor = el.filled ? el.color : 'none';
          const fillOpacity = el.filled ? 0.2 : 0; // Standardize opacity for filled shapes

          // PATH
          if (el.type === ElementType.PATH) {
              let d = el.pathData || `M ${el.points.map(p => `${p.x} ${p.y}`).join(' L ')}`;
              return (
                  <g key={el.id} opacity={opacity}>
                      <path d={d} stroke={strokeColor} strokeWidth={el.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      {selected && <path d={d} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" fill="none" pointerEvents="none" />}
                  </g>
              );
          }
          // LINE
          if (el.type === ElementType.LINE) {
              return (
                  <g key={el.id} opacity={opacity}>
                      <line x1={el.x} y1={el.y} x2={el.x2} y2={el.y2} stroke={strokeColor} strokeWidth={el.strokeWidth} strokeLinecap="round" />
                      {selected && <line x1={el.x} y1={el.y} x2={el.x2} y2={el.y2} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none" />}
                  </g>
              );
          }
          // RECT
          if (el.type === ElementType.RECT) {
              return (
                  <g key={el.id} opacity={opacity}>
                      <rect x={el.x} y={el.y} width={el.width} height={el.height} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} />
                      {selected && <rect x={el.x-2} y={el.y-2} width={el.width+4} height={el.height+4} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none"/>}
                  </g>
              );
          }
          // CIRCLE
          if (el.type === ElementType.CIRCLE) {
              return (
                  <g key={el.id} opacity={opacity}>
                      <circle cx={el.x + el.width/2} cy={el.y + el.height/2} r={el.width/2} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} />
                      {selected && <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none"/>}
                  </g>
              );
          }
          // TRIANGLE
          if (el.type === ElementType.TRIANGLE) {
              const p1 = `${el.x + el.width/2},${el.y}`;
              const p2 = `${el.x},${el.y + el.height}`;
              const p3 = `${el.x + el.width},${el.y + el.height}`;
              return (
                  <g key={el.id} opacity={opacity}>
                      <polygon points={`${p1} ${p2} ${p3}`} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} strokeLinejoin="round" />
                      {selected && <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none"/>}
                  </g>
              );
          }
          // IMAGE
          if (el.type === ElementType.IMAGE) {
              return (
                  <g key={el.id}>
                    <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="pointer-events-none">
                        <img src={el.src} className="w-full h-full object-cover rounded shadow-lg pointer-events-auto" />
                    </foreignObject>
                    {selected && <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={2} pointerEvents="none"/>}
                  </g>
              )
          }
          // TEXT
          if (el.type === ElementType.TEXT) {
             return (
                 <g key={el.id}>
                     <foreignObject x={el.x} y={el.y} width={500} height={500} className="pointer-events-none overflow-visible">
                        <div className="pointer-events-auto"><TextNode text={el.text} color={el.color} fontSize={el.fontSize} /></div>
                     </foreignObject>
                     {selected && <rect x={el.x-5} y={el.y-5} width={10} height={10} fill="#3b82f6" pointerEvents="none"/>}
                 </g>
             )
          }
          // SIM
          if (el.type === ElementType.SIMULATION) {
             return (
                 <g key={el.id}>
                     <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="overflow-visible">
                        <SimulationNode code={el.code} title={el.title} width={el.width} height={el.height} selected={selected} />
                     </foreignObject>
                     {selected && <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={2} pointerEvents="none"/>}
                 </g>
             )
          }
          return null;
      };

      return (
        <svg
          ref={svgRef}
          className="w-full h-full block"
          viewBox={`${view.x} ${view.y} ${window.innerWidth / view.scale} ${window.innerHeight / view.scale}`}
        >
           <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e2e8f0" strokeWidth="1"/>
            </pattern>
           </defs>
           <rect x={view.x} y={view.y} width={window.innerWidth / view.scale} height={window.innerHeight / view.scale} fill="url(#grid)" />
           
           {elements.map(el => renderEl(el, selectedIds.has(el.id)))}
           {tempElement && renderEl(tempElement, false)}
           
           {currentPath && (
               <path d={`M ${currentPath.points.map(p => `${p.x} ${p.y}`).join(' L ')}`} stroke={currentPath.color} strokeWidth={currentPath.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
           )}

           {selectionRect && (
               <rect x={selectionRect.w < 0 ? selectionRect.x + selectionRect.w : selectionRect.x} 
                     y={selectionRect.h < 0 ? selectionRect.y + selectionRect.h : selectionRect.y} 
                     width={Math.abs(selectionRect.w)} height={Math.abs(selectionRect.h)} 
                     fill="rgba(59, 130, 246, 0.1)" stroke="#3b82f6" strokeWidth="1" strokeDasharray="4 4" />
           )}

           {/* Single Resize Handle for current selection (simplification) */}
           {selectedIds.size === 1 && (() => {
               const id = Array.from(selectedIds)[0];
               const el = elements.find(e => e.id === id);
               if (el && 'width' in el) {
                   return <rect x={el.x + el.width - 5} y={el.y + el.height - 5} width={10} height={10} fill="#3b82f6" className="cursor-nwse-resize" />
               }
               return null;
           })()}

           {textInputPos && (
             <foreignObject x={textInputPos.x} y={textInputPos.y} width={300} height={150}>
                 <textarea
                    ref={textInputRef}
                    className="w-full h-full bg-transparent border-2 border-blue-500 rounded p-1 outline-none resize-none overflow-hidden"
                    style={{ fontSize: '24px', color: currentColor }}
                    value={inputTextValue}
                    onChange={(e) => setInputTextValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finalizeText(); }}}
                    placeholder="Type..."
                 />
             </foreignObject>
          )}
        </svg>
      );
  }, [elements, view, currentPath, tempElement, selectedIds, selectionRect, textInputPos, inputTextValue, currentColor, finalizeText, isFilled]);


  // --- API Connections (Same as before but using new tools) ---
  const connectToLiveAPI = async () => {
      // ... (Code identical to previous version but calling updated executeTools)
      // I will implement the connection block to be safe, ensuring context is correct
      if (isConnectingRef.current) return;
      isConnectingRef.current = true;
      try {
        if (!process.env.API_KEY) { alert("API Key missing"); return; }
        if (window.aistudio?.hasSelectedApiKey) {
            const hasKey = await window.aistudio.hasSelectedApiKey();
            if (!hasKey) await window.aistudio.openSelectKey();
        }

        inputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = mediaStream;

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const sessionPromise = ai.live.connect({
            model: MODEL_NAMES.LIVE,
            callbacks: {
                onopen: () => {
                    setAiState(s => ({ ...s, isConnected: true, modelState: 'listening' }));
                    if (inputContextRef.current) {
                        const source = inputContextRef.current.createMediaStreamSource(mediaStream);
                        const processor = inputContextRef.current.createScriptProcessor(4096, 1, 1);
                        processor.onaudioprocess = (e) => {
                            const input = e.inputBuffer.getChannelData(0);
                            const resampled = resampleTo16k(input, inputContextRef.current!.sampleRate);
                            sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(resampled) }));
                            
                            // Visualizer Calc
                            let sum = 0;
                            for (let i = 0; i < input.length; i+=10) sum += input[i]*input[i];
                            const rms = Math.sqrt(sum/(input.length/10));
                            window.dispatchEvent(new CustomEvent('audio-volume-update', { detail: rms }));
                        };
                        source.connect(processor);
                        processor.connect(inputContextRef.current.destination);
                    }
                    // Video Loop
                    let lastVer = -1;
                    videoIntervalRef.current = window.setInterval(async () => {
                        if (canvasVersion.current === lastVer || isDraggingRef.current) return;
                        const b64 = await getScreenCapture();
                        if (b64) {
                            lastVer = canvasVersion.current;
                            sessionPromise.then(s => s.sendRealtimeInput({ media: { mimeType: 'image/jpeg', data: b64 }}));
                        }
                    }, 3000);
                },
                onmessage: async (msg: LiveServerMessage) => {
                    const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                    if (audio && audioContextRef.current) {
                        setAiState(s => ({...s, modelState: 'speaking'}));
                        const buf = await decodeAudioData(decodeAudio(audio), audioContextRef.current);
                        const src = audioContextRef.current.createBufferSource();
                        src.buffer = buf;
                        src.connect(audioContextRef.current.destination);
                        const t = Math.max(audioContextRef.current.currentTime, nextStartTime.current);
                        src.start(t);
                        nextStartTime.current = t + buf.duration;
                        src.onended = () => {
                            if (audioContextRef.current && audioContextRef.current.currentTime >= nextStartTime.current - 0.1)
                                setAiState(s => ({...s, modelState: 'listening'}));
                        }
                    }
                    if (msg.toolCall) {
                        const res = await executeTools(msg.toolCall.functionCalls);
                        sessionPromise.then(s => s.sendToolResponse({ functionResponses: res as any }));
                    }
                },
                onclose: () => disconnect(),
                onerror: (e) => { console.error(e); disconnect(); }
            },
            config: {
                responseModalities: [Modality.AUDIO],
                tools: [{ functionDeclarations: whiteboardTools }],
                systemInstruction: SYSTEM_INSTRUCTION
            }
        });
        liveSession.current = sessionPromise;
      } catch (e) { console.error(e); isConnectingRef.current = false; disconnect(); } 
      finally { isConnectingRef.current = false; }
  };

  const disconnect = () => {
    if (liveSession.current) liveSession.current.then((s:any) => s.close()).catch(() => {});
    liveSession.current = null;
    audioContextRef.current?.close(); audioContextRef.current = null;
    inputContextRef.current?.close(); inputContextRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
    setAiState(s => ({ ...s, isConnected: false, modelState: 'idle' }));
  };

  const handleSendText = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!chatInputText.trim()) return;
      setChatInputText("");
      setIsChatProcessing(true);
      try {
          if (!process.env.API_KEY) throw new Error("API Key missing");
          if (!chatSessionRef.current) {
              const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
              chatSessionRef.current = ai.chats.create({
                  model: MODEL_NAMES.THINKING,
                  config: {
                      tools: [{ functionDeclarations: whiteboardTools }],
                      systemInstruction: SYSTEM_INSTRUCTION
                  }
              });
          }
          const b64 = await getScreenCapture();
          const parts: any[] = [{ text: chatInputText }];
          if (b64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });

          const res = await chatSessionRef.current.sendMessage({ message: parts });
          const fcs = res.candidates?.[0]?.content?.parts?.filter(p => p.functionCall).map(p => p.functionCall);
          
          if (fcs && fcs.length > 0) {
              const responses = await executeTools(fcs);
              await chatSessionRef.current.sendMessage({
                  message: responses.map(r => ({ functionResponse: { name: r.name, response: r.response } }))
              });
          }
      } catch (e) { console.error(e); } finally { setIsChatProcessing(false); }
  };

  return (
    <div className="w-full h-screen overflow-hidden relative bg-gray-50 touch-none select-none">
      <div 
        ref={canvasRef}
        className={`w-full h-full ${currentTool === ToolType.PAN ? 'cursor-grab' : 'cursor-crosshair'}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={(e) => {
            if (e.ctrlKey) {
                const s = e.deltaY > 0 ? view.scale / 1.05 : view.scale * 1.05;
                setView(v => ({ ...v, scale: Math.max(0.1, Math.min(s, 5)) }));
            } else {
                setView(v => ({ ...v, x: v.x + e.deltaX/v.scale, y: v.y + e.deltaY/v.scale }));
            }
        }}
      >
        {canvasContent}
      </div>

      <Toolbar 
        currentTool={currentTool} 
        setTool={setTool} 
        currentColor={currentColor}
        setColor={setColor}
        filled={isFilled}
        setFilled={setIsFilled}
        aiState={aiState}
        onToggleMic={() => aiState.isConnected ? disconnect() : connectToLiveAPI()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onZoomIn={() => setView(v => ({...v, scale: Math.min(v.scale * 1.2, 5)}))}
        onZoomOut={() => setView(v => ({...v, scale: Math.max(v.scale / 1.2, 0.1)}))}
        canUndo={historyIndex > 0}
        canRedo={historyIndex < history.length - 1}
      />

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 pointer-events-none">
         <form onSubmit={handleSendText} className="pointer-events-auto flex items-center gap-2 bg-white/95 backdrop-blur-md p-2 rounded-full shadow-2xl border border-gray-200">
             <div className="pl-3 text-gray-400"><MessageSquare size={20} /></div>
             <input type="text" value={chatInputText} onChange={e => setChatInputText(e.target.value)} placeholder="Message Gemini..." disabled={isChatProcessing} className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-2" />
             <button type="submit" disabled={!chatInputText.trim() || isChatProcessing} className="p-2 bg-blue-600 text-white rounded-full disabled:bg-gray-100 disabled:text-gray-400">
                {isChatProcessing ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
             </button>
         </form>
      </div>
    </div>
  );
};

export default App;