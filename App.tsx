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
import { generateImageContent, generateSimulationCode, generateVectorDrawing, sendChatProxy, API_BASE_URL } from './services/geminiService';
import { Send, MessageSquare, Loader2, X, Mic, Square, Sparkles } from 'lucide-react';

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
    try {
        const dataInt16 = new Int16Array(data.buffer);
        const buffer = ctx.createBuffer(1, dataInt16.length, 24000);
        const channelData = buffer.getChannelData(0);
        for (let i = 0; i < channelData.length; i++) {
            channelData[i] = dataInt16[i] / 32768.0;
        }
        return buffer;
    } catch (e) {
        console.error("Audio decode error", e);
        return null;
    }
};

const playAudio = async (base64: string, audioContext: AudioContext, nextStartTime: React.MutableRefObject<number>) => {
    if (!audioContext) return;
    try {
        const arrayBuffer = decodeAudio(base64);
        const audioBuffer = await decodeAudioData(arrayBuffer, audioContext);
        if (!audioBuffer) return;
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        const startTime = Math.max(audioContext.currentTime, nextStartTime.current);
        source.start(startTime);
        nextStartTime.current = startTime + audioBuffer.duration;
    } catch (e) { console.error("Playback error", e); }
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
        mime_type: 'audio/pcm;rate=16000',
    } as any;
}

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

    // Properties
    const [currentColor, setColor] = useState<string>('#000000');
    const [isFilled, setIsFilled] = useState(false);
    const [fontSize, setFontSize] = useState(24);
    const [theme, setTheme] = useState<'light' | 'dark'>('light');

    // History State
    const [history, setHistory] = useState<CanvasElement[][]>([[]]);
    const [historyIndex, setHistoryIndex] = useState(0);

    // Interaction State
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState<Point | null>(null);
    const [interactionMode, setInteractionMode] = useState<'idle' | 'drawing' | 'moving' | 'resizing' | 'rotating' | 'panning' | 'selecting'>('idle');

    // Selection
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectionRect, setSelectionRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);

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
    const chatInputRef = useRef<HTMLTextAreaElement>(null);
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
    const apiKeyRef = useRef<string | null>(null);

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

    // Auto-resize chat textarea
    useEffect(() => {
        if (chatInputRef.current) {
            chatInputRef.current.style.height = 'auto';
            chatInputRef.current.style.height = Math.min(chatInputRef.current.scrollHeight, 150) + 'px';
        }
    }, [chatInputText, showChat]);

    // Scroll to bottom of chat
    useEffect(() => {
        if (showChat) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages, showChat]);

    // Helper to determine selected element type
    const selectedElementType = useMemo(() => {
        if (selectedIds.size !== 1) return null;
        const el = elements.find(e => selectedIds.has(e.id));
        return el ? el.type : null;
    }, [selectedIds, elements]);

    // --- Helpers ---
    const pushToHistory = (newElements: CanvasElement[]) => {
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(newElements);
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
        setElements(newElements);
    };

    const pushToHistoryAsync = (newElements: CanvasElement[]) => {
        const currentHist = historyRef.current;
        const currentIndex = historyIndexRef.current;
        const newHistory = currentHist.slice(0, currentIndex + 1);
        newHistory.push(newElements);
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
        setElements(newElements);
    };

    // Property Change Handlers
    const handleColorChange = (color: string) => {
        setColor(color);
        if (selectedIds.size > 0) {
            const newEls = elements.map(el => selectedIds.has(el.id) ? { ...el, color } : el);
            pushToHistory(newEls);
        }
    };

    const handleFillChange = (filled: boolean) => {
        setIsFilled(filled);
        if (selectedIds.size > 0) {
            const newEls = elements.map(el => selectedIds.has(el.id) ? { ...el, filled } : el);
            pushToHistory(newEls);
        }
    };

    const handleFontSizeChange = (size: number) => {
        setFontSize(size);
        if (selectedIds.size > 0) {
            const newEls = elements.map(el => selectedIds.has(el.id) && el.type === ElementType.TEXT ? { ...el, fontSize: size } as TextElement : el);
            pushToHistory(newEls);
        }
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
        const scale = Math.min(Math.min(scaleX, scaleY), 1);

        setView({ x: minX - padding, y: minY - padding, scale });
    };

    const handleImageUpload = () => fileInputRef.current?.click();

    const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const b64 = await fileToBase64(file);
            const img = new Image();
            img.onload = () => {
                const maxWidth = 500;
                const ratio = img.width / img.height;
                const width = Math.min(img.width, maxWidth);
                const height = width / ratio;
                const centerX = view.x + (window.innerWidth / view.scale) / 2 - width / 2;
                const centerY = view.y + (window.innerHeight / view.scale) / 2 - height / 2;
                const newEl: ImageElement = {
                    id: Date.now().toString(), type: ElementType.IMAGE, x: centerX, y: centerY, width, height, src: b64, color: '#000000', rotation: 0
                };
                pushToHistory([...elements, newEl]);
            };
            img.src = b64;
        } catch (err) { console.error("Failed to load image", err); }
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    /**
     * Captures the current board as a base64 JPEG.
     * Cleans the SVG clone to remove elements that might taint the canvas,
     * such as iframes in simulations, ensuring exporting works smoothly.
     */
    const getScreenCapture = async (): Promise<string | null> => {
        if (!svgRef.current) return null;
        try {
            const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
            const foreignObjects = clone.querySelectorAll('foreignObject');

            foreignObjects.forEach(fo => {
                // Simulations (iframes) definitely taint the canvas.
                // We replace them with a colored box so the model sees where they are.
                if (fo.querySelector('iframe')) {
                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('x', fo.getAttribute('x') || '0');
                    rect.setAttribute('y', fo.getAttribute('y') || '0');
                    rect.setAttribute('width', fo.getAttribute('width') || '100');
                    rect.setAttribute('height', fo.getAttribute('height') || '100');
                    rect.setAttribute('fill', '#6366f1');
                    rect.setAttribute('opacity', '0.5');
                    fo.parentNode?.replaceChild(rect, fo);
                }
            });

            const serializer = new XMLSerializer();
            const svgStr = serializer.serializeToString(clone);
            const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(svgBlob);

            return new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const maxWidth = 512; // Standard size for model input
                    const scale = Math.min(1, maxWidth / window.innerWidth);
                    canvas.width = window.innerWidth * scale;
                    canvas.height = window.innerHeight * scale;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }

                    ctx.fillStyle = theme === 'dark' ? '#171717' : '#f3f4f6';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    try {
                        const base64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
                        URL.revokeObjectURL(url);
                        resolve(base64);
                    } catch (e) {
                        console.warn("Canvas capture tainted despite cleaning. Sending null.", e);
                        URL.revokeObjectURL(url);
                        resolve(null);
                    }
                };
                img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
                img.src = url;
            });
        } catch { return null; }
    };

    const executeTools = async (functionCalls: any[]) => {
        const responses = [];
        let addedElements: CanvasElement[] = [];
        let shouldClear = false;
        let toDeleteIds: Set<string> = new Set();
        let toMove: Array<{ id: string, x: number, y: number }> = [];
        const currentElements = elementsRef.current;
        const currentView = viewRef.current;

        const findElementAt = (x: number, y: number): string | null => {
            const found = currentElements.slice().reverse().find(el => {
                const cx = 'width' in el ? el.x + el.width / 2 : el.x;
                const cy = 'width' in el ? el.y + el.height / 2 : el.y;
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
                    if (targetId) { toDeleteIds.add(targetId); result = { result: "Element deleted." }; }
                    else { result = { result: "No element found at that location." }; }

                } else if (name === 'move_element_at') {
                    const targetId = findElementAt(args.x, args.y);
                    if (targetId) { toMove.push({ id: targetId, x: args.new_x, y: args.new_y }); result = { result: "Element moved." }; }
                    else { result = { result: "No element found at that location." }; }

                } else if (['draw_rectangle', 'draw_circle', 'draw_triangle'].includes(name)) {
                    let type = ElementType.RECT;
                    if (name === 'draw_circle') type = ElementType.CIRCLE;
                    if (name === 'draw_triangle') type = ElementType.TRIANGLE;
                    const el: ShapeElement = {
                        id, type: type as any, x: args.x, y: args.y,
                        width: args.radius ? args.radius * 2 : args.width,
                        height: args.radius ? args.radius * 2 : args.height,
                        color: args.color, filled: args.filled, rotation: 0
                    };
                    if (name === 'draw_circle') { el.x -= args.radius; el.y -= args.radius; }
                    addedElements.push(el);

                } else if (name === 'draw_line') {
                    addedElements.push({ id, type: ElementType.LINE, x: args.x1, y: args.y1, x2: args.x2, y2: args.y2, color: args.color, strokeWidth: args.strokeWidth || 3, filled: true, rotation: 0 });

                } else if (name === 'draw_path') {
                    addedElements.push({ id, type: ElementType.PATH, x: 0, y: 0, points: [], pathData: args.pathData, color: args.color, strokeWidth: args.strokeWidth || 3, filled: false, rotation: 0 });

                } else if (name === 'write_text') {
                    addedElements.push({ id, type: ElementType.TEXT, x: args.x, y: args.y, text: args.text, fontSize: 24, color: args.color || '#000000', filled: true, rotation: 0 });

                } else if (name === 'clear_board') {
                    shouldClear = true; addedElements = [];

                } else if (name === 'generate_image') {
                    const placeholder: ShapeElement = { id, type: ElementType.RECT, x: args.x, y: args.y, width: 300, height: 300, color: '#e2e8f0', filled: true, isLoading: true, rotation: 0 };
                    addedElements.push(placeholder);
                    generateImageContent(args.prompt, args.size || '1K').then(b64 => {
                        const currentEls = elementsRef.current;
                        let newEls;
                        if (b64) newEls = currentEls.map(el => el.id === id ? { ...el, type: ElementType.IMAGE, src: b64, isLoading: false, color: '#000' } as ImageElement : el);
                        else newEls = currentEls.filter(el => el.id !== id);
                        pushToHistoryAsync(newEls);
                    });
                    result = { result: "Image generation started in background." };

                } else if (name === 'generate_simulation') {
                    const placeholder: ShapeElement = { id, type: ElementType.RECT, x: args.x, y: args.y, width: 500, height: 400, color: '#e2e8f0', filled: true, isLoading: true, rotation: 0 };
                    addedElements.push(placeholder);
                    generateSimulationCode(args.prompt).then(code => {
                        const currentEls = elementsRef.current;
                        let newEls;
                        if (code) newEls = currentEls.map(el => el.id === id ? { ...el, type: ElementType.SIMULATION, code, title: args.title, isLoading: false, color: '#fff' } as any : el);
                        else newEls = currentEls.filter(el => el.id !== id);
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
                                const baseX = args.x + (s.x || 0); const baseY = args.y + (s.y || 0);
                                if (s.type === 'rect' || s.type === 'triangle') return { id: subId, type: s.type === 'rect' ? ElementType.RECT : ElementType.TRIANGLE, x: baseX, y: baseY, width: s.width, height: s.height, color: s.color, filled: s.filled, rotation: 0 };
                                else if (s.type === 'circle') return { id: subId, type: ElementType.CIRCLE, x: baseX - s.radius, y: baseY - s.radius, width: s.radius * 2, height: s.radius * 2, color: s.color, filled: s.filled, rotation: 0 };
                                else if (s.type === 'line') return { id: subId, type: ElementType.LINE, x: args.x + s.x1, y: args.y + s.y1, x2: args.x + s.x2, y2: args.y + s.y2, color: s.color, strokeWidth: s.strokeWidth, filled: true, rotation: 0 };
                                else if (s.type === 'path') return { id: subId, type: ElementType.PATH, x: args.x, y: args.y, points: [], pathData: s.pathData, color: s.color, strokeWidth: s.strokeWidth, filled: false, rotation: 0 };
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
                const newElements = elements.map(el => el.id === editingId ? { ...el, text: inputTextValue, color: currentColor, fontSize: fontSize } as TextElement : el);
                pushToHistory(newElements);
            } else {
                const newEl: TextElement = { id: Date.now().toString(), type: ElementType.TEXT, x: textInputPos.x, y: textInputPos.y, text: inputTextValue, fontSize: fontSize, color: currentColor, filled: true, rotation: 0 };
                pushToHistory([...elements, newEl]);
            }
        }
        setEditingId(null); setTextInputPos(null); setInputTextValue("");
    }, [textInputPos, inputTextValue, elements, currentColor, fontSize, editingId]);

    // --- Render ---
    const canvasContent = useMemo(() => {
        const renderEl = (el: CanvasElement, selected: boolean) => {
            const opacity = selected ? 0.8 : 1;
            const strokeColor = el.color;
            const fillColor = el.filled ? el.color : 'none';
            const fillOpacity = el.filled ? 0.2 : 0;
            const rotation = el.rotation || 0;

            let cx = el.x; let cy = el.y;
            if ('width' in el) { cx = el.x + el.width / 2; cy = el.y + el.height / 2; }
            if (el.type === ElementType.LINE) { cx = (el.x + el.x2) / 2; cy = (el.y + el.y2) / 2; }
            const transform = `rotate(${rotation}, ${cx}, ${cy})`;

            if (el.isLoading) {
                const w = 'width' in el ? el.width : 100;
                const h = 'height' in el ? el.height : 100;
                return (
                    <g key={el.id} transform={transform}>
                        <defs>
                            <linearGradient id={`grad-${el.id}`} x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" style={{ stopColor: '#3b82f6', stopOpacity: 0.15 }} />
                                <stop offset="50%" style={{ stopColor: '#8b5cf6', stopOpacity: 0.15 }} />
                                <stop offset="100%" style={{ stopColor: '#ec4899', stopOpacity: 0.15 }} />
                            </linearGradient>
                        </defs>
                        <rect x={el.x} y={el.y} width={w} height={h} rx="16" fill={`url(#grad-${el.id})`} stroke="#e2e8f0" strokeWidth={2} strokeDasharray="8 4">
                            <animate attributeName="stroke-dashoffset" from="0" to="24" dur="2s" repeatCount="indefinite" />
                        </rect>
                        <foreignObject x={el.x} y={el.y} width={w} height={h}>
                            <div className="w-full h-full flex items-center justify-center flex-col gap-4 p-6">
                                <div className="relative flex items-center justify-center">
                                    <div className="absolute inset-0 bg-blue-500/20 blur-xl rounded-full animate-pulse" />
                                    <Sparkles className="text-indigo-500 animate-bounce relative z-10" size={32} />
                                    <Loader2 className="absolute inset-0 text-pink-500 animate-spin opacity-40" size={32} />
                                </div>
                                <div className="flex flex-col items-center">
                                    <span className="text-xs font-black uppercase tracking-widest text-gray-400 mb-1">Processing</span>
                                    <span className="text-sm font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 animate-pulse text-center">
                                        Gemini is manifesting...
                                    </span>
                                </div>
                            </div>
                        </foreignObject>
                    </g>
                )
            }

            let content = null;
            let selectionBox = null;

            if (el.type === ElementType.PATH) {
                let d = el.pathData || `M ${el.points.map(p => `${p.x} ${p.y}`).join(' L ')}`;
                content = <path d={d} stroke={strokeColor} strokeWidth={el.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
                if (selected) selectionBox = <path d={d} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" fill="none" pointerEvents="none" />;
            } else if (el.type === ElementType.LINE) {
                content = <line x1={el.x} y1={el.y} x2={el.x2} y2={el.y2} stroke={strokeColor} strokeWidth={el.strokeWidth} strokeLinecap="round" />;
                if (selected) selectionBox = <line x1={el.x} y1={el.y} x2={el.x2} y2={el.y2} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none" />;
            } else if (el.type === ElementType.RECT) {
                content = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} />;
                if (selected) selectionBox = <rect x={el.x - 2} y={el.y - 2} width={el.width + 4} height={el.height + 4} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none" />;
            } else if (el.type === ElementType.CIRCLE) {
                content = <circle cx={el.x + el.width / 2} cy={el.y + el.height / 2} r={el.width / 2} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} />;
                if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none" />;
            } else if (el.type === ElementType.TRIANGLE) {
                const p1 = `${el.x + el.width / 2},${el.y}`; const p2 = `${el.x},${el.y + el.height}`; const p3 = `${el.x + el.width},${el.y + el.height}`;
                content = <polygon points={`${p1} ${p2} ${p3}`} fill={fillColor} fillOpacity={fillOpacity} stroke={strokeColor} strokeWidth={2} strokeLinejoin="round" />;
                if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" pointerEvents="none" />;
            } else if (el.type === ElementType.IMAGE) {
                content = (<> <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="pointer-events-none"> <img src={el.src} className="w-full h-full object-cover rounded shadow-lg pointer-events-auto select-none" draggable={false} /> </foreignObject> <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="transparent" /> </>);
                if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={2} pointerEvents="none" />;
            } else if (el.type === ElementType.TEXT) {
                if (editingId === el.id) return null;
                content = (<foreignObject x={el.x} y={el.y} width={500} height={500} className="pointer-events-none overflow-visible"> <div className="pointer-events-auto"><TextNode text={el.text} color={el.color} fontSize={el.fontSize} /></div> </foreignObject>);
                if (selected) selectionBox = <rect x={el.x - 5} y={el.y - 5} width={10} height={10} fill="#3b82f6" pointerEvents="none" />;
            } else if (el.type === ElementType.SIMULATION) {
                content = (<> <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="overflow-visible"> <SimulationNode code={el.code} title={el.title} width={el.width} height={el.height} selected={selected} /> </foreignObject> <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="transparent" pointerEvents={selected ? "none" : "auto"} /> </>);
                if (selected) selectionBox = <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth={2} pointerEvents="none" />;
            }

            return (
                <g key={el.id} opacity={opacity} transform={transform}>
                    {content}
                    {selectionBox}
                    {selected && (
                        <g>
                            {'width' in el && <rect x={el.x + el.width - 5} y={el.y + el.height - 5} width={10} height={10} fill="#3b82f6" className="cursor-nwse-resize" />}
                            {'width' in el && (<g className="cursor-grab"> <line x1={el.x + el.width / 2} y1={el.y} x2={el.x + el.width / 2} y2={el.y - 20} stroke="#3b82f6" strokeWidth={1} /> <circle cx={el.x + el.width / 2} cy={el.y - 20} r={4} fill="#white" stroke="#3b82f6" strokeWidth={2} /> </g>)}
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
                        <path d="M 40 0 L 0 0 0 40" fill="none" stroke={theme === 'dark' ? '#333' : '#e2e8f0'} strokeWidth="1" />
                    </pattern>
                </defs>
                <rect x={view.x} y={view.y} width={window.innerWidth / view.scale} height={window.innerHeight / view.scale} fill="url(#grid)" />

                {elements.map(el => renderEl(el, selectedIds.has(el.id)))}
                {tempElement && renderEl(tempElement, false)}
                {currentPath && (<path d={`M ${currentPath.points.map(p => `${p.x} ${p.y}`).join(' L ')}`} stroke={currentPath.color} strokeWidth={currentPath.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}

                {selectionRect && (
                    <rect x={selectionRect.w < 0 ? selectionRect.x + selectionRect.w : selectionRect.x} y={selectionRect.h < 0 ? selectionRect.y + selectionRect.h : selectionRect.y}
                        width={Math.abs(selectionRect.w)} height={Math.abs(selectionRect.h)} fill="rgba(59, 130, 246, 0.1)" stroke="#3b82f6" strokeWidth="1" strokeDasharray="4 4" />
                )}

                {textInputPos && (
                    <foreignObject x={textInputPos.x} y={textInputPos.y} width={500} height={300}>
                        <textarea
                            ref={textInputRef}
                            className="w-full h-full bg-transparent border-none outline-none focus:ring-0 p-1 resize-none overflow-hidden"
                            style={{ fontSize: `${fontSize}px`, color: currentColor, lineHeight: 1.5 }}
                            value={inputTextValue}
                            onChange={(e) => setInputTextValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finalizeText(); }
                                e.stopPropagation();
                            }}
                            placeholder="Type..."
                            autoFocus
                        />
                    </foreignObject>
                )}
            </svg>
        );
    }, [elements, view, currentPath, tempElement, selectedIds, selectionRect, textInputPos, inputTextValue, currentColor, finalizeText, isFilled, editingId, theme, fontSize]);


    const disconnect = useCallback(() => {
        if (liveSession.current) liveSession.current.then((s: any) => s.close()).catch(() => { });
        liveSession.current = null;
        audioContextRef.current?.close(); audioContextRef.current = null;
        inputContextRef.current?.close(); inputContextRef.current = null;
        streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
        if (videoIntervalRef.current) clearInterval(videoIntervalRef.current);
        videoIntervalRef.current = undefined;
        setAiState(s => ({ ...s, isConnected: false, modelState: 'idle' }));
    }, []);

    const connectToLiveAPI = async () => {
        if (liveSession.current || isConnectingRef.current) return;
        isConnectingRef.current = true;
        setAiState(s => ({ ...s, modelState: 'connecting' }));
        try {
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = API_BASE_URL
                ? API_BASE_URL.replace('http', 'ws') + '/api/live'
                : `${wsProtocol}//${window.location.host}/api/live`;
            const ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log("Connected to Live API Proxy");
                const setup = {
                    setup: {
                        model: `models/${MODEL_NAMES.LIVE}`,
                        generation_config: { response_modalities: ["audio"] },
                        system_instruction: {
                            role: "system",
                            parts: [{ text: SYSTEM_INSTRUCTION }]
                        },
                        tools: [{ function_declarations: whiteboardTools }]
                    }
                };
                ws.send(JSON.stringify(setup));
            };

            ws.onmessage = async (event) => {
                const data = JSON.parse(event.data);

                if (data.setupComplete || data.setup_complete) {
                    setAiState(s => ({ ...s, isConnected: true, modelState: 'idle' }));
                    isConnectingRef.current = false;
                    startStreaming(ws);
                }

                if (data.serverContent || data.server_content) {
                    const content = data.serverContent || data.server_content;
                    const turn = content.modelTurn || content.model_turn;
                    if (turn) {
                        for (const part of turn.parts) {
                            if (part.inlineData || part.inline_data) {
                                const inline = part.inlineData || part.inline_data;
                                if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
                                playAudio(inline.data, audioContextRef.current, nextStartTime);
                                setAiState(s => ({ ...s, modelState: 'speaking' }));
                            }
                            const call = part.call || part.function_call || part.functionCall;
                            if (call) {
                                const toolResponses = await executeTools(call.functionCalls || call.function_calls);
                                ws.send(JSON.stringify({
                                    tool_response: { function_responses: toolResponses.map(tr => ({ response: tr.response, id: tr.id })) }
                                }));
                            }
                        }
                    }
                    if (content.interleaved) {
                        for (const part of content.interleaved.parts) {
                            if (part.inlineData || part.inline_data) {
                                const inline = part.inlineData || part.inline_data;
                                if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
                                playAudio(inline.data, audioContextRef.current, nextStartTime);
                            }
                        }
                    }
                }

                if (data.toolCall || data.tool_call) {
                    const call = data.toolCall || data.tool_call;
                    const toolResponses = await executeTools(call.functionCalls || call.function_calls);
                    ws.send(JSON.stringify({
                        tool_response: { function_responses: toolResponses.map(tr => ({ response: tr.response, id: tr.id })) }
                    }));
                }
            };

            ws.onclose = () => {
                console.log("Google Live API disconnected");
                disconnect();
            };

            ws.onerror = (e) => {
                console.error("WebSocket Error", e);
                disconnect();
            };

            liveSession.current = Promise.resolve(ws);
        } catch (e) {
            console.error("Live connection failed", e);
            isConnectingRef.current = false;
            setAiState(s => ({ ...s, isConnected: false, modelState: 'idle' }));
        }
    };

    const startStreaming = async (ws: WebSocket) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            inputContextRef.current = new AudioContext({ sampleRate: 16000 });
            const source = inputContextRef.current.createMediaStreamSource(stream);
            const processor = inputContextRef.current.createScriptProcessor(4096, 1, 1);

            source.connect(processor);
            processor.connect(inputContextRef.current.destination);

            processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = createBlob(inputData);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ realtime_input: { media_chunks: [pcmData] } }));
                }
            };

            // Video/Board capture every 2 seconds
            videoIntervalRef.current = window.setInterval(async () => {
                const b64 = await getScreenCapture();
                if (b64 && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ realtime_input: { media_chunks: [{ data: b64, mime_type: 'image/jpeg' }] } }));
                }
            }, 2000);

        } catch (e) {
            console.error("Mic stream failed", e);
            disconnect();
        }
    };


    const handleStartRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream);
            mediaRecorderRef.current = recorder;
            audioChunksRef.current = [];
            recorder.ondataavailable = (event) => { if (event.data.size > 0) audioChunksRef.current.push(event.data); };
            recorder.start();
            setIsRecordingChat(true);
        } catch (e) { console.error("Mic error", e); }
    };

    const handleStopRecording = async () => {
        if (!mediaRecorderRef.current) return;
        return new Promise<void>((resolve) => {
            mediaRecorderRef.current!.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = async () => {
                    const base64Audio = (reader.result as string).split(',')[1];
                    await sendChatMessage(undefined, base64Audio, 'audio/wav');
                    setIsRecordingChat(false);
                    mediaRecorderRef.current?.stream.getTracks().forEach(t => t.stop());
                    resolve();
                };
            };
            mediaRecorderRef.current!.stop();
        });
    };

    const handleMicClick = () => {
        if (isRecordingChat) handleStopRecording();
        else handleStartRecording();
    };

    const sendChatMessage = async (text?: string, audioBase64?: string, audioMime?: string) => {
        if (!text && !audioBase64) return;
        const userMsg = text || (audioBase64 ? "🎤 Audio Message" : "");
        setChatMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text: userMsg }]);
        setChatInputText("");
        setIsChatProcessing(true);
        setShowChat(true);

        try {
            const b64Screen = await getScreenCapture();

            const result = await sendChatProxy(
                [...chatMessages, { role: 'user', text: userMsg }],
                b64Screen,
                whiteboardTools,
                SYSTEM_INSTRUCTION
            );

            if (result.error) throw new Error(result.error);

            if (result.text) {
                setChatMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: result.text }]);
            }

            if (result.functionCalls && result.functionCalls.length > 0) {
                const toolResponses = await executeTools(result.functionCalls.map(fc => fc.functionCall));
                // Note: For a true multi-turn chat with tools, we would send these back to the proxy.
                // For now, this executes the drawing actions on the board.
            }
        } catch (e) {
            console.error("Chat Error:", e);
            setChatMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: "Sorry, I'm having trouble connecting to my brain right now." }]);
        } finally {
            setIsChatProcessing(false);
        }
    };

    const handleSendText = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (chatInputText.trim()) sendChatMessage(chatInputText);
    };

    const handleChatKeyDown = (e: React.KeyboardEvent) => {
        e.stopPropagation();
        // Handle "Enter" to send message and "Shift+Enter" for newline
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (chatInputText.trim() && !isChatProcessing && !isRecordingChat) {
                sendChatMessage(chatInputText);
            }
        }
    };

    const getPointerPos = (e: React.PointerEvent) => {
        const svg = svgRef.current;
        if (!svg) return { x: 0, y: 0 };
        const rect = svg.getBoundingClientRect();
        return { x: view.x + (e.clientX - rect.left) / view.scale, y: view.y + (e.clientY - rect.top) / view.scale };
    };

    const hitTest = (x: number, y: number): CanvasElement | undefined => {
        return elements.slice().reverse().find(el => {
            const padding = 10 / view.scale;
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
                const A = x - el.x; const B = y - el.y; const C = el.x2 - el.x; const D = el.y2 - el.y;
                const dot = A * C + B * D; const lenSq = C * C + D * D;
                let param = -1; if (lenSq !== 0) param = dot / lenSq;
                let xx, yy; if (param < 0) { xx = el.x; yy = el.y; } else if (param > 1) { xx = el.x2; yy = el.y2; } else { xx = el.x + param * C; yy = el.y + param * D; }
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

        // Check Rotation/Resize Handles
        if (selectedIds.size === 1) {
            const id = Array.from(selectedIds)[0];
            const el = elements.find(e => e.id === id);
            if (el && 'width' in el) {
                const handleSize = 20 / view.scale;
                const cx = el.x + el.width / 2;
                const cy = el.y + el.height / 2;
                const rot = (el.rotation || 0) * Math.PI / 180;
                const cos = Math.cos(rot);
                const sin = Math.sin(rot);

                const dx = el.width / 2;
                const dy = el.height / 2;
                const rx = cx + dx * cos - dy * sin;
                const ry = cy + dx * sin + dy * cos;

                if (Math.hypot(x - rx, y - ry) < handleSize) {
                    setInteractionMode('resizing');
                    setDragStart({ x, y });
                    return;
                }

                const rDx = 0;
                const rDy = -el.height / 2 - 20;
                const rrx = cx + rDx * cos - rDy * sin;
                const rry = cy + rDx * sin + rDy * cos;

                if (Math.hypot(x - rrx, y - rry) < handleSize * 2) {
                    setInteractionMode('rotating');
                    setDragStart({ x, y });
                    return;
                }
            }
        }

        if (currentTool === ToolType.TEXT) {
            if (textInputPos) { finalizeText(); return; }
            const hit = hitTest(x, y);
            if (hit && hit.type === ElementType.TEXT) {
                setEditingId(hit.id); setTextInputPos({ x: hit.x, y: hit.y }); setInputTextValue(hit.text); setColor(hit.color); setFontSize(hit.fontSize);
                return;
            }
            setTextInputPos({ x, y }); setInputTextValue(""); return;
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
                } else {
                    if (!selectedIds.has(hit.id)) {
                        setSelectedIds(new Set([hit.id]));
                        setColor(hit.color);
                        if ('filled' in hit) setIsFilled(!!hit.filled);
                        if (hit.type === ElementType.TEXT) setFontSize(hit.fontSize);
                    }
                }
            } else {
                setInteractionMode('selecting'); setSelectionRect({ x, y, w: 0, h: 0 });
                if (!e.shiftKey) setSelectedIds(new Set());
            }
            return;
        }
        if (currentTool === ToolType.ERASER) { setInteractionMode('drawing'); setIsDragging(true); eraseAt(x, y); return; }
        setInteractionMode('drawing');
        const id = Date.now().toString();
        if (currentTool === ToolType.PEN) setCurrentPath({ id, type: ElementType.PATH, x: 0, y: 0, points: [{ x, y }], color: currentColor, strokeWidth: 3, filled: false, rotation: 0 });
        else if (currentTool === ToolType.LINE) setTempElement({ id, type: ElementType.LINE, x, y, x2: x, y2: y, color: currentColor, strokeWidth: 3, filled: true, rotation: 0 });
        else if (['rect', 'circle', 'triangle'].includes(currentTool)) {
            const type = currentTool === 'rect' ? ElementType.RECT : currentTool === 'circle' ? ElementType.CIRCLE : ElementType.TRIANGLE;
            setTempElement({ id, type: type as any, x, y, width: 0, height: 0, color: currentColor, filled: isFilled, rotation: 0 });
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (requestRef.current) return;
        requestRef.current = requestAnimationFrame(() => {
            requestRef.current = undefined;
            const { x, y } = getPointerPos(e);
            const dx = e.movementX / view.scale; const dy = e.movementY / view.scale;
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
                    if (el.id === id && 'width' in el) {
                        const cx = el.x + el.width / 2;
                        const cy = el.y + el.height / 2;
                        const rad = (el.rotation || 0) * Math.PI / 180;
                        const cos = Math.cos(rad);
                        const sin = Math.sin(rad);
                        const vX = x - cx;
                        const vY = y - cy;
                        const localMX = vX * cos + vY * sin;
                        const localMY = -vX * sin + vY * cos;
                        const newW = Math.max(10, Math.abs(localMX) * 2);
                        const newH = Math.max(10, Math.abs(localMY) * 2);
                        return { ...el, width: newW, height: newH, x: cx - newW / 2, y: cy - newH / 2 };
                    }
                    return el;
                }));
            }
            else if (interactionMode === 'rotating' && selectedIds.size === 1) {
                const id = Array.from(selectedIds)[0];
                setElements(prev => prev.map(el => {
                    if (el.id === id && 'width' in el) {
                        const cx = el.x + el.width / 2; const cy = el.y + el.height / 2;
                        const angleRad = Math.atan2(y - cy, x - cx);
                        let angleDeg = (angleRad * 180 / Math.PI) + 90;
                        if (e.shiftKey) angleDeg = Math.round(angleDeg / 15) * 15;
                        return { ...el, rotation: angleDeg };
                    }
                    return el;
                }));
            }
            else if (interactionMode === 'selecting' && selectionRect) setSelectionRect(prev => prev ? { ...prev, w: x - prev.x, h: y - prev.y } : null);
            else if (interactionMode === 'drawing') {
                if (currentTool === ToolType.PEN && currentPath) setCurrentPath(prev => prev ? { ...prev, points: [...prev.points, { x, y }] } : null);
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
            let newEl = null; if (currentPath) newEl = currentPath;
            if (tempElement) {
                newEl = { ...tempElement };
                if ('width' in newEl) {
                    if (newEl.width < 0) { newEl.x += newEl.width; newEl.width = Math.abs(newEl.width); }
                    if (newEl.height < 0) { newEl.y += newEl.height; newEl.height = Math.abs(newEl.height); }
                }
            }
            if (newEl) pushToHistory([...elements, newEl]);
        } else if (interactionMode === 'selecting' && selectionRect) {
            const rx = selectionRect.w < 0 ? selectionRect.x + selectionRect.w : selectionRect.x;
            const ry = selectionRect.h < 0 ? selectionRect.y + selectionRect.h : selectionRect.y;
            const rw = Math.abs(selectionRect.w); const rh = Math.abs(selectionRect.h);
            const newSelected = new Set(selectedIds);
            elements.forEach(el => {
                let cx = el.x, cy = el.y; if ('width' in el) { cx += el.width / 2; cy += el.height / 2; }
                if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) newSelected.add(el.id);
            });
            setSelectedIds(newSelected);
        } else if (['moving', 'resizing', 'rotating'].includes(interactionMode)) pushToHistory(elements);
        setInteractionMode('idle'); setDragStart(null); setCurrentPath(null); setTempElement(null); setSelectionRect(null); setIsDragging(false);
    };
    const eraseAt = (x: number, y: number) => { const hit = hitTest(x, y); if (hit) setElements(prev => prev.filter(e => e.id !== hit.id)); };

    return (
        <div className={`w-full h-screen overflow-hidden relative touch-none select-none transition-colors duration-300 ${theme === 'dark' ? 'bg-zinc-900' : 'bg-gray-50'}`}>
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
                    } else { setView(v => ({ ...v, x: v.x + e.deltaX / v.scale, y: v.y + e.deltaY / v.scale })); }
                }}
            >
                {canvasContent}
            </div>

            <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={onFileChange} />

            <Toolbar
                currentTool={currentTool}
                setTool={setTool}
                currentColor={currentColor}
                setColor={handleColorChange}
                filled={isFilled}
                setFilled={handleFillChange}
                fontSize={fontSize}
                setFontSize={handleFontSizeChange}
                theme={theme}
                setTheme={setTheme}
                aiState={aiState}
                isAIProcessing={isAIProcessing}
                onToggleMic={() => aiState.isConnected ? disconnect() : connectToLiveAPI()}
                onUndo={handleUndo}
                onRedo={handleRedo}
                onZoomIn={() => setView(v => ({ ...v, scale: Math.min(v.scale * 1.2, 5) }))}
                onZoomOut={() => setView(v => ({ ...v, scale: Math.max(v.scale / 1.2, 0.1) }))}
                onFitView={handleFitView}
                onImageUpload={handleImageUpload}
                onDelete={deleteSelected}
                hasSelection={selectedIds.size > 0}
                selectedElementType={selectedElementType}
                canUndo={historyIndex > 0}
                canRedo={historyIndex < history.length - 1}
            />

            {/* CHAT INTERFACE */}
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 pointer-events-none flex flex-col gap-2 z-50">
                {chatMessages.length > 0 && showChat && (
                    <div className={`backdrop-blur-md rounded-2xl shadow-2xl border p-4 max-h-[400px] overflow-y-auto pointer-events-auto flex flex-col gap-3 mb-2 transition-colors duration-200 ${theme === 'dark' ? 'bg-black/80 border-white/10' : 'bg-white/95 border-gray-200'}`}>
                        <div className={`flex justify-between items-center border-b pb-2 mb-1 ${theme === 'dark' ? 'border-white/10' : 'border-gray-200'}`}>
                            <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Chat History</span>
                            <button onClick={() => setShowChat(false)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
                        </div>
                        {chatMessages.map(msg => (
                            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed shadow-sm ${msg.role === 'user'
                                    ? 'bg-blue-600 text-white rounded-tr-sm'
                                    : (theme === 'dark' ? 'bg-zinc-800 text-gray-200 border border-white/5 rounded-tl-sm' : 'bg-gray-100 text-gray-800 border border-gray-200 rounded-tl-sm')
                                    }`}>
                                    {msg.role === 'model' ? <ReactMarkdown>{msg.text}</ReactMarkdown> : msg.text}
                                </div>
                            </div>
                        ))}
                        <div ref={chatEndRef} />
                    </div>
                )}

                <form onSubmit={handleSendText} className={`pointer-events-auto flex items-end gap-2 backdrop-blur-md p-2 rounded-3xl shadow-2xl transition-all duration-200 ${theme === 'dark' ? 'bg-zinc-900/90 shadow-black/50' : 'bg-white/95 shadow-xl'}`}>
                    <div className="pl-2 pb-2 text-gray-400 cursor-pointer hover:text-blue-500 transition-colors" onClick={() => setShowChat(!showChat)} title="Toggle Chat"><MessageSquare size={20} /></div>

                    <textarea
                        ref={chatInputRef}
                        value={chatInputText}
                        onChange={e => setChatInputText(e.target.value)}
                        onKeyDown={handleChatKeyDown}
                        placeholder={isRecordingChat ? "Recording..." : "Message Gemini... (Enter to send)"}
                        disabled={isChatProcessing || isRecordingChat}
                        rows={1}
                        className={`flex-1 bg-transparent border-none focus:ring-0 text-sm py-3 text-gray-900 placeholder-gray-500 resize-none max-h-[150px] scrollbar-hide ${theme === 'dark' ? 'text-white placeholder-gray-500' : 'text-gray-900'}`}
                    />

                    <div className="flex gap-2 pb-1 pr-1">
                        <button
                            type="button"
                            onClick={handleMicClick}
                            disabled={isChatProcessing}
                            className={`p-2.5 rounded-full transition-all duration-200 ${isRecordingChat ? 'bg-red-500 text-white animate-pulse scale-110' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}
                            title="Click to Record"
                        >
                            {isRecordingChat ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
                        </button>

                        <button type="submit" disabled={!chatInputText.trim() || isChatProcessing || isRecordingChat} className={`p-2.5 rounded-full transition-all duration-200 flex items-center justify-center ${(!chatInputText.trim() && !isChatProcessing) ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-md hover:shadow-lg'}`}>
                            {isChatProcessing ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} className={chatInputText.trim() ? "ml-0.5" : ""} />}
                        </button>
                    </div>

                    {chatInputText.length > 0 && (
                        <div className="absolute -top-6 right-4 text-[10px] text-gray-400 font-medium tracking-wide">
                            {chatInputText.length} chars • Enter to send
                        </div>
                    )}
                </form>
            </div>
        </div>
    );
};

export default App;