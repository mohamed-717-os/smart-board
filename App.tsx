import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
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
  TextElement,
  ChatMessage,
  ImageElement
} from './types';
import { MODEL_NAMES, whiteboardTools, SYSTEM_INSTRUCTION } from './constants';
import { Toolbar } from './components/Toolbar';
import { SimulationNode } from './components/SimulationNode';
import { TextNode } from './components/TextNode';
import { generateImageContent, generateSimulationCode, generateVectorDrawing } from './services/geminiService';
import { Send, MessageSquare, Loader2, X, RotateCw, Mic } from 'lucide-react';

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

// Convert File to Base64
const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};

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
  const [interactionMode, setInteractionMode] = useState<'idle' | 'drawing' | 'moving' | 'resizing' | 'rotating' | 'panning' | 'selecting'>('idle');
  
  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionRect, setSelectionRect] = useState<{x:number, y:number, w:number, h:number} | null>(null);

  // Drawing Buffers
  const [currentPath, setCurrentPath] = useState<PathElement | null>(null);
  const [tempElement, setTempElement] = useState<CanvasElement | null>(null);

  // Text Input
  const [textInputPos, setTextInputPos] = useState<Point | null>(null);
  const [inputTextValue, setInputTextValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // --- AI State ---
  const [aiState, setAiState] = useState<AIState>({ isConnected: false, isListening: false, modelState: 'idle' });
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  
  // Chat State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInputText, setChatInputText] = useState("");
  const [isChatProcessing, setIsChatProcessing] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [isRecordingChat, setIsRecordingChat] = useState(false);

  // Refs
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const requestRef = useRef<number | undefined>(undefined);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // Live API Refs
  const liveSession = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const nextStartTime = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const isConnectingRef = useRef(false);
  const videoIntervalRef = useRef<number | undefined>(undefined);
  
  // State Refs for Callbacks
  const viewRef = useRef(view);
  const elementsRef = useRef(elements);
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);

  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { elementsRef.current = elements; }, [elements]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);

  // Chat API Ref
  const chatSessionRef = useRef<Chat | null>(null);

  // Opt Refs
  const canvasVersion = useRef(0);
  const isDraggingRef = useRef(false);

  useEffect(() => { canvasVersion.current += 1; }, [elements]);
  useEffect(() => { isDraggingRef.current = isDragging; }, [isDragging]);
  
  // Scroll to bottom of chat
  useEffect(() => {
    if (showChat) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, showChat]);

  // --- Helpers ---
  const pushToHistory = (newElements: CanvasElement[]) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newElements);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setElements(newElements);
  };
  
  // Helper to push history from async callbacks using refs
  const pushToHistoryAsync = (newElements: CanvasElement[]) => {
      const currentHist = historyRef.current;
      const currentIndex = historyIndexRef.current;
      const newHistory = currentHist.slice(0, currentIndex + 1);
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

  const handleFitView = () => {
      if (elements.length === 0) {
          setView({ x: 0, y: 0, scale: 1 });
          return;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      elements.forEach(el => {
          let x = el.x, y = el.y, w = 0, h = 0;
          if ('width' in el) { w = el.width; h = el.height; }
          else if (el.type === ElementType.LINE) { w = el.x2 - el.x; h = el.y2 - el.y; }
          else if (el.type === ElementType.PATH) {
             // Rough box for paths
             el.points.forEach(p => {
                 minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                 minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
             });
             return;
          }
          if (w < 0) { x += w; w = Math.abs(w); }
          if (h < 0) { y += h; h = Math.abs(h); }
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w);
          maxY = Math.max(maxY, y + h);
      });
      
      const padding = 50;
      const width = maxX - minX + padding * 2;
      const height = maxY - minY + padding * 2;
      if (width <= 0 || height <= 0) return;

      const scaleX = window.innerWidth / width;
      const scaleY = window.innerHeight / height;
      const scale = Math.min(Math.min(scaleX, scaleY), 1); // Don't zoom in too much
      
      setView({
          x: minX - padding,
          y: minY - padding,
          scale
      });
  };

  // --- Image Upload ---
  const handleImageUpload = () => {
      fileInputRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
          const b64 = await fileToBase64(file);
          // Get image dimensions
          const img = new Image();
          img.onload = () => {
              const maxWidth = 500;
              const ratio = img.width / img.height;
              const width = Math.min(img.width, maxWidth);
              const height = width / ratio;
              
              // Place in center of current view
              const centerX = view.x + (window.innerWidth / view.scale) / 2 - width / 2;
              const centerY = view.y + (window.innerHeight / view.scale) / 2 - height / 2;

              const newEl: ImageElement = {
                  id: Date.now().toString(),
                  type: ElementType.IMAGE,
                  x: centerX,
                  y: centerY,
                  width,
                  height,
                  src: b64,
                  color: '#000000',
                  rotation: 0
              };
              pushToHistory([...elements, newEl]);
          };
          img.src = b64;
      } catch (err) {
          console.error("Failed to load image", err);
      }
      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = "";
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
    let toDeleteIds: Set<string> = new Set();
    let toMove: Array<{id: string, x: number, y: number}> = [];

    // Use Refs to ensure we work with latest state in callbacks
    const currentElements = elementsRef.current;
    const currentView = viewRef.current;

    const findElementAt = (x: number, y: number): string | null => {
         const found = currentElements.slice().reverse().find(el => {
             const cx = 'width' in el ? el.x + el.width/2 : el.x;
             const cy = 'width' in el ? el.y + el.height/2 : el.y;
             return Math.hypot(cx - x, cy - y) < 100; 
         });
         return found ? found.id : null;
    };

    for (const fc of functionCalls) {
        const { name, args } = fc;
        let result = { result: "ok" };
        const id = Date.now().toString() + Math.random();

        try {
            if (name === 'pan_view') {
                const newX = args.x - (window.innerWidth / currentView.scale) / 2;
                const newY = args.y - (window.innerHeight / currentView.scale) / 2;
                setView(v => ({ ...v, x: newX, y: newY }));
                result = { result: "View moved." };

            } else if (name === 'delete_element_at') {
                 const targetId = findElementAt(args.x, args.y);
                 if (targetId) {
                     toDeleteIds.add(targetId);
                     result = { result: "Element deleted." };
                 } else {
                     result = { result: "No element found at that location." };
                 }

            } else if (name === 'move_element_at') {
                 const targetId = findElementAt(args.x, args.y);
                 if (targetId) {
                     toMove.push({ id: targetId, x: args.new_x, y: args.new_y });
                     result = { result: "Element moved." };
                 } else {
                     result = { result: "No element found at that location." };
                 }

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
                    filled: args.filled,
                    rotation: 0
                };
                if (name === 'draw_circle') { el.x -= args.radius; el.y -= args.radius; }
                addedElements.push(el);

            } else if (name === 'draw_line') {
                addedElements.push({
                    id, type: ElementType.LINE,
                    x: args.x1, y: args.y1,
                    x2: args.x2, y2: args.y2,
                    color: args.color, strokeWidth: args.strokeWidth || 3, filled: true, rotation: 0
                });

            } else if (name === 'draw_path') {
                addedElements.push({
                    id, type: ElementType.PATH,
                    x: 0, y: 0, points: [],
                    pathData: args.pathData,
                    color: args.color, strokeWidth: args.strokeWidth || 3, filled: false, rotation: 0
                });

            } else if (name === 'write_text') {
                addedElements.push({
                    id, type: ElementType.TEXT,
                    x: args.x, y: args.y,
                    text: args.text, fontSize: 24, color: args.color || '#000000', filled: true, rotation: 0
                });

            } else if (name === 'clear_board') {
                shouldClear = true;
                addedElements = [];

            } else if (name === 'generate_image') {
                const placeholder: ShapeElement = {
                    id, type: ElementType.RECT, x: args.x, y: args.y, width: 300, height: 300,
                    color: '#e2e8f0', filled: true, isLoading: true, rotation: 0
                };
                addedElements.push(placeholder);
                generateImageContent(args.prompt, args.size || '1K').then(b64 => {
                     // Update using Ref to ensure we capture the most recent state
                     const currentEls = elementsRef.current;
                     let newEls;
                     if (b64) {
                        newEls = currentEls.map(el => el.id === id ? {
                            ...el, type: ElementType.IMAGE, src: b64, isLoading: false, color: '#000'
                        } as ImageElement : el);
                     } else {
                        newEls = currentEls.filter(el => el.id !== id);
                     }
                     pushToHistoryAsync(newEls);
                });
                result = { result: "Image generation started in background." };

            } else if (name === 'generate_simulation') {
                const placeholder: ShapeElement = {
                    id, type: ElementType.RECT, x: args.x, y: args.y, width: 500, height: 400,
                    color: '#e2e8f0', filled: true, isLoading: true, rotation: 0
                };
                addedElements.push(placeholder);
                generateSimulationCode(args.prompt).then(code => {
                    const currentEls = elementsRef.current;
                     let newEls;
                     if (code) {
                        newEls = currentEls.map(el => el.id === id ? {
                            ...el, type: ElementType.SIMULATION, code, title: args.title, isLoading: false, color: '#fff'
                        } as any : el);
                     } else {
                        newEls = currentEls.filter(el => el.id !== id);
                     }
                     pushToHistoryAsync(newEls);
                });
                result = { result: "Simulation generation started in background." };

            } else if (name === 'generate_vector_drawing') {
                setIsAIProcessing(true);
                generateVectorDrawing(args.prompt).then(shapes => {
                    setIsAIProcessing(false);
                    if (shapes && Array.isArray(shapes)) {
                        const newShapes = shapes.map((s: any) => {
                             const subId = Date.now().toString() + Math.random();
                             const baseX = args.x + (s.x || 0);
                             const baseY = args.y + (s.y || 0);
                             if (s.type === 'rect' || s.type === 'triangle') {
                                return { id: subId, type: s.type === 'rect' ? ElementType.RECT : ElementType.TRIANGLE, x: baseX, y: baseY, width: s.width, height: s.height, color: s.color, filled: s.filled, rotation: 0 };
                             } else if (s.type === 'circle') {
                                return { id: subId, type: ElementType.CIRCLE, x: baseX - s.radius, y: baseY - s.radius, width: s.radius*2, height: s.radius*2, color: s.color, filled: s.filled, rotation: 0 };
                             } else if (s.type === 'line') {
                                return { id: subId, type: ElementType.LINE, x: args.x + s.x1, y: args.y + s.y1, x2: args.x + s.x2, y2: args.y + s.y2, color: s.color, strokeWidth: s.strokeWidth, filled: true, rotation: 0 };
                             } else if (s.type === 'path') {
                                return { id: subId, type: ElementType.PATH, x: args.x, y: args.y, points: [], pathData: s.pathData, color: s.color, strokeWidth: s.strokeWidth, filled: false, rotation: 0 };
                             }
                             return null;
                        }).filter(Boolean);
                        const finalElements = [...elementsRef.current, ...newShapes as any];
                        pushToHistoryAsync(finalElements);
                    }
                });
                result = { result: "Vector drawing started in background." };
            }

        } catch (e) { console.error(e); result = { result: "Error." }; }
        responses.push({ id: fc.id, name: fc.name, response: result });
    }

    if (shouldClear || addedElements.length > 0 || toDeleteIds.size > 0 || toMove.length > 0) {
        // We use the Ref to calculate the next state, then update React state
        let next = shouldClear ? [] : [...elementsRef.current];
        if (toDeleteIds.size > 0) next = next.filter(el => !toDeleteIds.has(el.id));
        if (toMove.length > 0) {
             next = next.map(el => {
                 const moveOp = toMove.find(m => m.id === el.id);
                 if (moveOp) return { ...el, x: moveOp.x, y: moveOp.y };
                 return el;
             });
        }
        next = [...next, ...addedElements];
        
        pushToHistory(next);
    }
    return responses;
  };

  const finalizeText = useCallback(() => {
      if (textInputPos && inputTextValue.trim()) {
          if (editingId) {
              const newElements = elements.map(el => el.id === editingId ? { ...el, text: inputTextValue } as TextElement : el);
              pushToHistory(newElements);
          } else {
              const newEl: TextElement = { id: Date.now().toString(), type: ElementType.TEXT, x: textInputPos.x, y: textInputPos.y, text: inputTextValue, fontSize: 24, color: currentColor, filled: true, rotation: 0 };
              pushToHistory([...elements, newEl]);
          }
      }
      setEditingId(null);
      setTextInputPos(null); setInputTextValue("");
  }, [textInputPos, inputTextValue, elements, currentColor, editingId]);

  // --- Render ---
  const canvasContent = useMemo(() => {
      const renderEl = (el: CanvasElement, selected: boolean) => {
          const opacity = selected ? 0.8 : 1;
          const strokeColor = el.color;
          const fillColor = el.filled ? el.color : 'none';
          const fillOpacity = el.filled ? 0.2 : 0; 
          const rotation = el.rotation || 0;
          
          let cx = el.x;
          let cy = el.y;
          if ('width' in el) { cx = el.x + el.width/2; cy = el.y + el.height/2; }
          // Line approx center
          if (el.type === ElementType.LINE) { cx = (el.x + el.x2)/2; cy = (el.y + el.y2)/2; }
          
          const transform = `rotate(${rotation}, ${cx}, ${cy})`;

          if (el.isLoading) {
               const w = 'width' in el ? el.width : 100;
               const h = 'height' in el ? el.height : 100;
               return (
                   <g key={el.id} opacity={0.7} transform={transform}>
                       <rect x={el.x} y={el.y} width={w} height={h} fill="#f3f4f6" stroke="#9ca3af" strokeWidth={2} strokeDasharray="5 5" />
                       <foreignObject x={el.x} y={el.y} width={w} height={h}>
                           <div className="w-full h-full flex items-center justify-center flex-col gap-2 text-gray-500">
                               <Loader2 className="animate-spin" size={24} />
                               <span className="text-xs font-semibold">Creating...</span>
                           </div>
                       </foreignObject>
                   </g>
               )
          }

          let content = null;
          let selectionBox = null;

          // PATH
          if (el.type === ElementType.PATH) {
              let d = el.pathData || `M ${el.points.map(p => `${p.x} ${p.y}`).join(' L ')}`;
              content = <path d={d} stroke={strokeColor} strokeWidth={el.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
              if (selected) selectionBox = <path d={d} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" fill="none" pointerEvents="none" />;
          }
          // LINE
          else if (el.type === ElementType.LINE) {
              content = <line x1={el.x} y1={el.y} x2={el.x2} y2={el.y2} stroke={strokeColor} strokeWidth={el.strokeWidth} strokeLinecap="round" />;
              if (selected) selectionBox = <line x1={el.x} y1={el.y} x2={el.x2} y2={el.y2} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none" />;
          }
          // RECT
          else if (el.type === ElementType.RECT) {
              content = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} />;
              if (selected) selectionBox = <rect x={el.x-2} y={el.y-2} width={el.width+4} height={el.height+4} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none"/>;
          }
          // CIRCLE
          else if (el.type === ElementType.CIRCLE) {
              content = <circle cx={el.x + el.width/2} cy={el.y + el.height/2} r={el.width/2} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} />;
              if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none"/>;
          }
          // TRIANGLE
          else if (el.type === ElementType.TRIANGLE) {
              const p1 = `${el.x + el.width/2},${el.y}`;
              const p2 = `${el.x},${el.y + el.height}`;
              const p3 = `${el.x + el.width},${el.y + el.height}`;
              content = <polygon points={`${p1} ${p2} ${p3}`} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} strokeLinejoin="round" />;
              if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none"/>;
          }
          // IMAGE
          else if (el.type === ElementType.IMAGE) {
              content = (
                  <>
                    <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="pointer-events-none">
                        <img src={el.src} className="w-full h-full object-cover rounded shadow-lg pointer-events-auto select-none" draggable={false} />
                    </foreignObject>
                    {/* Transparent overlay to capture mouse events for moving */}
                    <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="transparent" />
                  </>
              );
              if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={2} pointerEvents="none"/>;
          }
          // TEXT
          else if (el.type === ElementType.TEXT) {
             if (editingId === el.id) return null;
             content = (
                 <foreignObject x={el.x} y={el.y} width={500} height={500} className="pointer-events-none overflow-visible">
                    <div className="pointer-events-auto"><TextNode text={el.text} color={el.color} fontSize={el.fontSize} /></div>
                 </foreignObject>
             );
             if (selected) selectionBox = <rect x={el.x-5} y={el.y-5} width={10} height={10} fill="#3b82f6" pointerEvents="none"/>;
          }
          // SIMULATION
          else if (el.type === ElementType.SIMULATION) {
             content = (
                 <>
                    <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="overflow-visible">
                        <SimulationNode code={el.code} title={el.title} width={el.width} height={el.height} selected={selected} />
                    </foreignObject>
                    <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="transparent" pointerEvents={selected ? "none" : "auto"} />
                 </>
             );
             if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={2} pointerEvents="none"/>;
          }

          return (
              <g key={el.id} opacity={opacity} transform={transform}>
                  {content}
                  {selectionBox}
                  {selected && (
                      <g>
                         {/* Resize Handle */}
                         {'width' in el && <rect x={el.x + el.width - 5} y={el.y + el.height - 5} width={10} height={10} fill="#3b82f6" className="cursor-nwse-resize" />}
                         {/* Rotation Handle */}
                         {'width' in el && (
                             <g className="cursor-grab">
                                 <line x1={el.x + el.width/2} y1={el.y} x2={el.x + el.width/2} y2={el.y - 20} stroke="#3b82f6" strokeWidth={1} />
                                 <circle cx={el.x + el.width/2} cy={el.y - 20} r={4} fill="#white" stroke="#3b82f6" strokeWidth={2} />
                             </g>
                         )}
                      </g>
                  )}
              </g>
          );
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
                    autoFocus
                 />
             </foreignObject>
          )}
        </svg>
      );
  }, [elements, view, currentPath, tempElement, selectedIds, selectionRect, textInputPos, inputTextValue, currentColor, finalizeText, isFilled, editingId]);


  const disconnect = useCallback(() => {
    if (liveSession.current) {
        liveSession.current.then((s:any) => s.close()).catch(() => {});
    }
    liveSession.current = null;
    audioContextRef.current?.close(); audioContextRef.current = null;
    inputContextRef.current?.close(); inputContextRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
    videoIntervalRef.current = undefined;
    setAiState(s => ({ ...s, isConnected: false, modelState: 'idle' }));
  }, []);

  const connectToLiveAPI = async () => {
      if (isConnectingRef.current) return;
      isConnectingRef.current = true;
      try {
        if (!process.env.API_KEY) { alert("API Key missing"); return; }
        if (window.aistudio?.hasSelectedApiKey) {
            const hasKey = await window.aistudio.hasSelectedApiKey();
            if (!hasKey) await window.aistudio.openSelectKey();
        }

        // Ensure clean state before connecting
        if (liveSession.current) {
            await liveSession.current.then((s:any) => s.close()).catch(() => {});
            liveSession.current = null;
        }
        
        inputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        const mediaStream = await navigator.mediaDevices.getUserMedia({
             audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 16000
             }
        });
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
                            if (!inputContextRef.current) return;
                            const input = e.inputBuffer.getChannelData(0);
                            const resampled = resampleTo16k(input, inputContextRef.current.sampleRate);
                            sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(resampled) }));
                            
                            let sum = 0;
                            for (let i = 0; i < input.length; i+=10) sum += input[i]*input[i];
                            const rms = Math.sqrt(sum/(input.length/10));
                            window.dispatchEvent(new CustomEvent('audio-volume-update', { detail: rms }));
                        };
                        source.connect(processor);
                        processor.connect(inputContextRef.current.destination);
                    }
                    
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
                onclose: () => {
                },
                onerror: (e) => { 
                    console.error("Live API Error:", e); 
                }
            },
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
                },
                tools: [{ functionDeclarations: whiteboardTools }],
                systemInstruction: SYSTEM_INSTRUCTION
            }
        });
        liveSession.current = sessionPromise;
      } catch (e) { console.error(e); isConnectingRef.current = false; disconnect(); } 
      finally { isConnectingRef.current = false; }
  };

  const handleStartRecording = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;
        audioChunksRef.current = [];

        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunksRef.current.push(event.data);
        };

        recorder.start();
        setIsRecordingChat(true);
    } catch (e) { console.error("Mic error", e); }
  };

  const handleStopRecording = async () => {
    if (!mediaRecorderRef.current) return;
    return new Promise<void>((resolve) => {
        mediaRecorderRef.current!.onstop = async () => {
             const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' }); // Default browser mime
             const reader = new FileReader();
             reader.readAsDataURL(audioBlob);
             reader.onloadend = async () => {
                 const base64Audio = (reader.result as string).split(',')[1];
                 await sendChatMessage(undefined, base64Audio, 'audio/wav');
                 setIsRecordingChat(false);
                 // Stop tracks
                 mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop());
                 resolve();
             };
        };
        mediaRecorderRef.current!.stop();
    });
  };

  const sendChatMessage = async (text?: string, audioBase64?: string, audioMime?: string) => {
      if (!text && !audioBase64) return;
      
      const userMsg = text || (audioBase64 ? "🎤 Audio Message" : "");
      setChatMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text: userMsg }]);
      setChatInputText("");
      setIsChatProcessing(true);
      setShowChat(true);

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
          const b64Screen = await getScreenCapture();
          const parts: any[] = [];
          if (text) parts.push({ text });
          if (audioBase64) parts.push({ inlineData: { mimeType: audioMime || 'audio/wav', data: audioBase64 } });
          if (b64Screen) parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64Screen } });

          let res = await chatSessionRef.current.sendMessage({ message: parts });
          let functionCalls = res.candidates?.[0]?.content?.parts?.filter(p => p.functionCall).map(p => p.functionCall);
          
          while (functionCalls && functionCalls.length > 0) {
              const responses = await executeTools(functionCalls);
              res = await chatSessionRef.current.sendMessage({
                  message: responses.map(r => ({ functionResponse: { name: r.name, response: r.response } }))
              });
              functionCalls = res.candidates?.[0]?.content?.parts?.filter(p => p.functionCall).map(p => p.functionCall);
          }

          const modelText = res.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || "";
          if (modelText) {
              setChatMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: modelText }]);
          }

      } catch (e) { 
          console.error(e); 
          setChatMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: "Sorry, I encountered an error processing that request." }]);
      } finally { 
          setIsChatProcessing(false); 
      }
  };

  const handleSendText = async (e: React.FormEvent) => {
      e.preventDefault();
      if (chatInputText.trim()) sendChatMessage(chatInputText);
  };

  const getPointerPos = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: view.x + (e.clientX - rect.left) / view.scale,
      y: view.y + (e.clientY - rect.top) / view.scale
    };
  };

  // Improved Hit Test Logic
  // Note: For simplicity, hit testing uses the un-rotated bounding box in this version.
  const hitTest = (x: number, y: number): CanvasElement | undefined => {
      return elements.slice().reverse().find(el => {
        const padding = 10 / view.scale;
        
        // Use a rotational transform check if rotated?
        // For now, simple box check is robust enough for basic usage unless highly rotated.
        
        if (el.type === ElementType.TEXT) {
             const estimatedWidth = Math.max(200, el.text.length * (el.fontSize * 0.6));
             const estimatedHeight = Math.max(50, (el.text.split('\n').length || 1) * (el.fontSize * 1.5));
             return x >= el.x - padding && x <= el.x + estimatedWidth + padding && y >= el.y - padding && y <= el.y + estimatedHeight + padding;
        }
        
        if (el.type === ElementType.PATH) {
             if (el.pathData) return Math.abs(el.x - x) < 50 && Math.abs(el.y - y) < 50;
             if (el.points.length) return el.points.some(p => Math.hypot(p.x - x, p.y - y) < padding * 2);
        }
        
        if (el.type === ElementType.LINE) {
             // Approximation for line hit
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
             return Math.hypot(dx, dy) < padding * 2;
        }
        
        if ('width' in el) return x >= el.x - padding && x <= el.x + el.width + padding && y >= el.y - padding && y <= el.y + el.height + padding;
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
  
  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    (e.target as Element).releasePointerCapture(e.pointerId);
    const { x, y } = getPointerPos(e);
    
    // Check Rotation Handle first
    if (selectedIds.size === 1) {
        const id = Array.from(selectedIds)[0];
        const el = elements.find(e => e.id === id);
        if (el && 'width' in el) {
             // Rotate handle is at top center - 20px
             let cx = el.x + el.width/2; 
             let cy = el.y + el.height/2;
             // We need to account for the current rotation of the handle itself
             // But the handle drawing is rotated by the group transform.
             // So visually it corresponds to the object's local (width/2, -20).
             // However, hit testing the screen coordinate against the rotated handle is complex.
             // Simplified: Check distance to the unrotated handle position, because we are clicking "through" the transform?
             // No, the mouse coordinates are in world space.
             // Let's just check if we are in "Resize" or "Rotate" mode by distance to corners/handle.
             
             // Simple Box check for now for Resize
             const handleSize = 20 / view.scale;
             if (Math.hypot(x - (el.x + el.width), y - (el.y + el.height)) < handleSize) {
                 setInteractionMode('resizing');
                 setDragStart({ x, y });
                 return;
             }
             
             // Approx Rotate check - Logic: The handle is visually at local (w/2, -20)
             // We can check if the mouse is "close" to the top center.
             if (Math.hypot(x - (el.x + el.width/2), y - (el.y - 20)) < handleSize * 2) {
                 setInteractionMode('rotating');
                 setDragStart({ x, y });
                 return;
             }
        }
    }

    // Text Tool - Editing Logic
    if (currentTool === ToolType.TEXT) {
        if (textInputPos) { finalizeText(); return; }
        const hit = hitTest(x, y);
        if (hit && hit.type === ElementType.TEXT) {
            setEditingId(hit.id);
            setTextInputPos({ x: hit.x, y: hit.y });
            setInputTextValue(hit.text);
            setColor(hit.color);
            return;
        }
        setTextInputPos({ x, y }); 
        setInputTextValue("");
        return;
    }

    if (textInputPos) { finalizeText(); return; }
    setDragStart({ x: e.clientX, y: e.clientY }); 
    if (currentTool === ToolType.PAN) { setInteractionMode('panning'); return; }
    
    if (currentTool === ToolType.SELECT) {
        const hit = hitTest(x, y);
        if (hit) {
            setInteractionMode('moving');
            if (e.shiftKey) {
                const newSet = new Set(selectedIds);
                if (newSet.has(hit.id)) newSet.delete(hit.id); else newSet.add(hit.id);
                setSelectedIds(newSet);
            } else { if (!selectedIds.has(hit.id)) setSelectedIds(new Set([hit.id])); }
        } else {
            setInteractionMode('selecting');
            setSelectionRect({ x, y, w: 0, h: 0 });
            if (!e.shiftKey) setSelectedIds(new Set());
        }
        return;
    }
    if (currentTool === ToolType.ERASER) { setInteractionMode('drawing'); setIsDragging(true); eraseAt(x, y); return; }
    setInteractionMode('drawing');
    const id = Date.now().toString();
    if (currentTool === ToolType.PEN) setCurrentPath({ id, type: ElementType.PATH, x: 0, y: 0, points: [{x, y}], color: currentColor, strokeWidth: 3, filled: false, rotation: 0 });
    else if (currentTool === ToolType.LINE) setTempElement({ id, type: ElementType.LINE, x, y, x2: x, y2: y, color: currentColor, strokeWidth: 3, filled: true, rotation: 0 });
    else if (currentTool === ToolType.RECTANGLE) setTempElement({ id, type: ElementType.RECT, x, y, width: 0, height: 0, color: currentColor, filled: isFilled, rotation: 0 });
    else if (currentTool === ToolType.CIRCLE) setTempElement({ id, type: ElementType.CIRCLE, x, y, width: 0, height: 0, color: currentColor, filled: isFilled, rotation: 0 });
    else if (currentTool === ToolType.TRIANGLE) setTempElement({ id, type: ElementType.TRIANGLE, x, y, width: 0, height: 0, color: currentColor, filled: isFilled, rotation: 0 });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (requestRef.current) return;
    requestRef.current = requestAnimationFrame(() => {
        requestRef.current = undefined;
        const { x, y } = getPointerPos(e);
        const dx = e.movementX / view.scale;
        const dy = e.movementY / view.scale;
        if (interactionMode === 'panning') setView(v => ({ ...v, x: v.x - dx, y: v.y - dy }));
        else if (interactionMode === 'moving') {
            setElements(prev => prev.map(el => {
                if (selectedIds.has(el.id)) {
                    if (el.type === ElementType.LINE) return { ...el, x: el.x + dx, y: el.y + dy, x2: el.x2 + dx, y2: el.y2 + dy };
                    if (el.type === ElementType.PATH && el.points.length) return { ...el, points: el.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
                    return { ...el, x: el.x + dx, y: el.y + dy };
                }
                return el;
            }));
        }
        else if (interactionMode === 'resizing' && selectedIds.size === 1) {
            const id = Array.from(selectedIds)[0];
            setElements(prev => prev.map(el => {
                if (el.id === id && 'width' in el) return { ...el, width: Math.max(10, x - el.x), height: Math.max(10, y - el.y) };
                return el;
            }));
        }
        else if (interactionMode === 'rotating' && selectedIds.size === 1) {
            const id = Array.from(selectedIds)[0];
            setElements(prev => prev.map(el => {
                if (el.id === id && 'width' in el) {
                    const cx = el.x + el.width/2;
                    const cy = el.y + el.height/2;
                    // Calculate angle from center to mouse
                    const angleRad = Math.atan2(y - cy, x - cx);
                    // Standardize: 0 degrees is usually East. 
                    // But our handle is at North (-Y).
                    // atan2(0, 1) = 0 (East). atan2(-1, 0) = -PI/2 (North).
                    // So we want North to be Rotation 0.
                    let angleDeg = (angleRad * 180 / Math.PI) + 90;
                    if (e.shiftKey) { // Snap to 15 deg
                        angleDeg = Math.round(angleDeg / 15) * 15;
                    }
                    return { ...el, rotation: angleDeg };
                }
                return el;
            }));
        }
        else if (interactionMode === 'selecting' && selectionRect) setSelectionRect(prev => prev ? { ...prev, w: x - prev.x, h: y - prev.y } : null);
        else if (interactionMode === 'drawing') {
            if (currentTool === ToolType.PEN && currentPath) setCurrentPath(prev => prev ? { ...prev, points: [...prev.points, {x, y}] } : null);
            if (currentTool === ToolType.ERASER) eraseAt(x, y);
            if (tempElement) {
                if (tempElement.type === ElementType.LINE) setTempElement({ ...tempElement, x2: x, y2: y });
                else if ('width' in tempElement) setTempElement(prev => { if (!prev || !('width' in prev)) return prev; const startX = prev.x; const startY = prev.y; return { ...prev, width: x - startX, height: y - startY }; });
            }
        }
    });
  };
  const handlePointerUp = () => {
    if (interactionMode === 'drawing') {
        let newEl = null;
        if (currentPath) newEl = currentPath;
        if (tempElement) {
            newEl = {...tempElement};
            if ('width' in newEl) {
                if (newEl.width < 0) { newEl.x += newEl.width; newEl.width = Math.abs(newEl.width); }
                if (newEl.height < 0) { newEl.y += newEl.height; newEl.height = Math.abs(newEl.height); }
            }
        }
        if (newEl) pushToHistory([...elements, newEl]);
    }
    else if (interactionMode === 'selecting' && selectionRect) {
        const rx = selectionRect.w < 0 ? selectionRect.x + selectionRect.w : selectionRect.x;
        const ry = selectionRect.h < 0 ? selectionRect.y + selectionRect.h : selectionRect.y;
        const rw = Math.abs(selectionRect.w);
        const rh = Math.abs(selectionRect.h);
        const newSelected = new Set(selectedIds);
        elements.forEach(el => {
            let cx = el.x, cy = el.y;
            if ('width' in el) { cx += el.width/2; cy += el.height/2; }
            if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) newSelected.add(el.id);
        });
        setSelectedIds(newSelected);
    }
    else if (interactionMode === 'moving' || interactionMode === 'resizing' || interactionMode === 'rotating') pushToHistory(elements);
    setInteractionMode('idle'); setDragStart(null); setCurrentPath(null); setTempElement(null); setSelectionRect(null); setIsDragging(false);
  };
  
  // Improved Erase Logic matching HitTest
  const eraseAt = (x: number, y: number) => {
    // Re-use hitTest logic but specifically for point click
    const hit = hitTest(x, y);
    if (hit) {
        setElements(prev => prev.filter(e => e.id !== hit.id));
    }
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
            } else { setView(v => ({ ...v, x: v.x + e.deltaX/v.scale, y: v.y + e.deltaY/v.scale })); }
        }}
      >
        {canvasContent}
      </div>
      
      {/* Hidden File Input */}
      <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={onFileChange} />

      <Toolbar 
        currentTool={currentTool} 
        setTool={setTool} 
        currentColor={currentColor}
        setColor={setColor}
        filled={isFilled}
        setFilled={setIsFilled}
        aiState={aiState}
        isAIProcessing={isAIProcessing}
        onToggleMic={() => aiState.isConnected ? disconnect() : connectToLiveAPI()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onZoomIn={() => setView(v => ({...v, scale: Math.min(v.scale * 1.2, 5)}))}
        onZoomOut={() => setView(v => ({...v, scale: Math.max(v.scale / 1.2, 0.1)}))}
        onFitView={handleFitView}
        onImageUpload={handleImageUpload}
        onDelete={deleteSelected}
        hasSelection={selectedIds.size > 0}
        canUndo={historyIndex > 0}
        canRedo={historyIndex < history.length - 1}
      />

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 pointer-events-none flex flex-col gap-2 z-50">
         {/* Chat Messages Overlay */}
         {chatMessages.length > 0 && showChat && (
             <div className="bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-gray-200 p-4 max-h-[300px] overflow-y-auto pointer-events-auto flex flex-col gap-3 mb-2">
                 <div className="flex justify-between items-center border-b pb-2 mb-1">
                     <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Chat History</span>
                     <button onClick={() => setShowChat(false)} className="text-gray-400 hover:text-gray-600"><X size={14}/></button>
                 </div>
                 {chatMessages.map(msg => (
                     <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                         <div className={`max-w-[85%] p-2.5 rounded-2xl text-sm leading-relaxed ${
                             msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-gray-100 text-gray-800 rounded-tl-sm border border-gray-200'
                         }`}>
                             {msg.role === 'model' ? <ReactMarkdown>{msg.text}</ReactMarkdown> : msg.text}
                         </div>
                     </div>
                 ))}
                 <div ref={chatEndRef} />
             </div>
         )}
         
         <form onSubmit={handleSendText} className="pointer-events-auto flex items-center gap-2 bg-white/95 backdrop-blur-md p-2 rounded-full shadow-2xl border border-gray-200">
             <div className="pl-3 text-gray-400 cursor-pointer" onClick={() => setShowChat(!showChat)} title="Toggle Chat"><MessageSquare size={20} /></div>
             <input type="text" value={chatInputText} onChange={e => setChatInputText(e.target.value)} placeholder="Message Gemini..." disabled={isChatProcessing || isRecordingChat} className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-2 text-gray-900 placeholder-gray-500" />
             
             {/* Chat Voice Input */}
             <button
                type="button"
                onPointerDown={handleStartRecording}
                onPointerUp={handleStopRecording}
                onPointerLeave={handleStopRecording}
                disabled={isChatProcessing}
                className={`p-2 rounded-full transition-colors ${isRecordingChat ? 'bg-red-500 text-white animate-pulse' : 'text-gray-500 hover:bg-gray-100'}`}
                title="Hold to Speak to Chat"
             >
                <Mic size={18} />
             </button>

             <button type="submit" disabled={!chatInputText.trim() || isChatProcessing || isRecordingChat} className="p-2 bg-blue-600 text-white rounded-full disabled:bg-gray-100 disabled:text-gray-400 transition-colors">
                {isChatProcessing ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
             </button>
         </form>
      </div>
    </div>
  );
};

export default App;