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
  Point,
  TextElement
} from './types';
import { MODEL_NAMES, whiteboardTools } from './constants';
import { Toolbar } from './components/Toolbar';
import { SimulationNode } from './components/SimulationNode';
import { TextNode } from './components/TextNode';
import { generateImageContent } from './services/geminiService';
import { Send, MessageSquare, Loader2 } from 'lucide-react';

// --- Audio Utils ---
const encodeAudio = (bytes: Uint8Array) => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const decodeAudio = (base64: string) => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

// Robust Linear Interpolation Resampler
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

const decodeAudioData = async (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1
): Promise<AudioBuffer> => {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
};

function createBlob(data: Float32Array): GenAIBlob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // Clamp to Int16 range to avoid overflow artifacts
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
  
  // History State
  const [history, setHistory] = useState<CanvasElement[][]>([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Interaction State
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null); 
  const [activeElementId, setActiveElementId] = useState<string | null>(null); 
  const [interactionMode, setInteractionMode] = useState<'idle' | 'drawing' | 'moving' | 'resizing' | 'panning'>('idle');
  const [currentPath, setCurrentPath] = useState<PathElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Text Input State
  const [textInputPos, setTextInputPos] = useState<Point | null>(null);
  const [inputTextValue, setInputTextValue] = useState("");

  // --- AI State ---
  const [aiState, setAiState] = useState<AIState>({
    isConnected: false,
    isListening: false,
    modelState: 'idle'
  });
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
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const volumeThrottleRef = useRef<number>(0);
  const videoIntervalRef = useRef<number | undefined>(undefined);
  const isConnectingRef = useRef(false);
  
  // Chat API Ref (for independent text chat)
  const chatSessionRef = useRef<Chat | null>(null);

  // --- Optimization Refs ---
  // Track changes to avoid sending duplicate frames
  const canvasVersion = useRef(0);
  // Track dragging state in ref for access inside interval closure
  const isDraggingRef = useRef(false);

  // Sync refs
  useEffect(() => {
    canvasVersion.current += 1;
  }, [elements]); // Increment version when elements change

  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

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
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setElements(history[newIndex]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setElements(history[newIndex]);
    }
  };

  // --- Vision Capture Helper ---
  const getScreenCapture = async (): Promise<string | null> => {
    if (!svgRef.current) return null;
    
    try {
        // Serialize SVG
        const serializer = new XMLSerializer();
        const svgStr = serializer.serializeToString(svgRef.current);
        const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                // Aggressive optimization: 500px max width is sufficient for AI context
                // Reducing pixel count significantly speeds up toDataURL
                const maxWidth = 500;
                const scale = Math.min(1, maxWidth / window.innerWidth);
                
                canvas.width = window.innerWidth * scale;
                canvas.height = window.innerHeight * scale;
                
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) {
                    URL.revokeObjectURL(url);
                    resolve(null);
                    return;
                }
                // Fill white background (SVG is transparent usually)
                ctx.fillStyle = '#f3f4f6';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                
                // Low quality JPEG (0.4) for minimal payload size
                const base64 = canvas.toDataURL('image/jpeg', 0.4).split(',')[1];
                URL.revokeObjectURL(url);
                resolve(base64);
            };
            img.onerror = () => {
                 URL.revokeObjectURL(url);
                 resolve(null);
            }
            img.src = url;
        });
    } catch (e) {
        console.error("Screen capture failed", e);
        return null;
    }
  };

  // --- Tool Execution (Shared by Live and Chat) ---
  const executeTools = async (functionCalls: any[]) => {
    const responses = [];
    let addedElements: CanvasElement[] = [];
    let shouldClear = false;

    for (const fc of functionCalls) {
        const { name, args } = fc;
        let result = { result: "ok" };

        try {
            if (name === 'draw_rectangle') {
                const newRect: ShapeElement = {
                    id: Date.now().toString() + Math.random(),
                    type: ElementType.RECT,
                    x: args.x, y: args.y, width: args.width, height: args.height,
                    color: args.color
                };
                addedElements.push(newRect);
            } else if (name === 'draw_circle') {
                const newCircle: ShapeElement = {
                    id: Date.now().toString() + Math.random(),
                    type: ElementType.CIRCLE,
                    x: args.x - args.radius, y: args.y - args.radius, 
                    width: args.radius * 2, height: args.radius * 2,
                    color: args.color
                };
                addedElements.push(newCircle);
            } else if (name === 'draw_path') {
                const newPath: PathElement = {
                    id: Date.now().toString() + Math.random(),
                    type: ElementType.PATH,
                    x: 0, y: 0, 
                    points: [],
                    pathData: args.pathData,
                    color: args.color,
                    strokeWidth: args.strokeWidth || 3
                };
                 addedElements.push(newPath);
            } else if (name === 'write_text') {
                const newText: TextElement = {
                    id: Date.now().toString() + Math.random(),
                    type: ElementType.TEXT,
                    x: args.x, y: args.y,
                    text: args.text,
                    fontSize: 24,
                    color: args.color || '#000000'
                };
                addedElements.push(newText);
            } else if (name === 'clear_board') {
                shouldClear = true;
                addedElements = [];
            } else if (name === 'generate_image') {
                const imageBase64 = await generateImageContent(args.prompt, args.size || '1K');
                if (imageBase64) {
                    const imgEl: CanvasElement = {
                        id: Date.now().toString(),
                        type: ElementType.IMAGE,
                        x: args.x, y: args.y, width: 300, height: 300,
                        src: imageBase64,
                        color: '#000000'
                    };
                    addedElements.push(imgEl);
                    result = { result: "Image generated successfully." };
                } else {
                    result = { result: "Failed to generate image." };
                }
            } else if (name === 'generate_simulation') {
                const simEl: CanvasElement = {
                    id: Date.now().toString(),
                    type: ElementType.SIMULATION,
                    x: args.x, y: args.y, width: 500, height: 400,
                    code: args.code,
                    title: args.title,
                    color: '#ffffff'
                };
                addedElements.push(simEl);
                result = { result: "Simulation created." };
            }
        } catch (e) {
            console.error("Tool execution error", e);
            result = { result: "Error executing tool." };
        }
        
        responses.push({
            id: fc.id,
            name: fc.name,
            response: result
        });
    }

    if (shouldClear || addedElements.length > 0) {
        setElements(prev => {
            const next = shouldClear ? [...addedElements] : [...prev, ...addedElements];
            setHistory(h => {
                const currentH = h.slice(0, historyIndex + 1);
                currentH.push(next);
                return currentH;
            });
            setHistoryIndex(idx => idx + 1);
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
      return elements.slice().reverse().find(el => {
        if ('width' in el) {
            return x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height;
        } else if (el.type === ElementType.TEXT) {
             return x >= el.x && x <= el.x + 200 && y >= el.y && y <= el.y + 50; 
        } else if (el.type === ElementType.PATH) {
             if (el.points.length > 0) {
                 const xs = el.points.map(p => p.x);
                 const ys = el.points.map(p => p.y);
                 const minX = Math.min(...xs) - 10;
                 const maxX = Math.max(...xs) + 10;
                 const minY = Math.min(...ys) - 10;
                 const maxY = Math.max(...ys) + 10;
                 return x >= minX && x <= maxX && y >= minY && y <= maxY;
             }
             if (el.pathData) {
                 return Math.abs(el.x - x) < 50 && Math.abs(el.y - y) < 50; 
             }
        }
        return false;
      });
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;

    (e.target as Element).releasePointerCapture(e.pointerId);
    const { x, y } = getPointerPos(e);
    
    if (currentTool === ToolType.TEXT) {
        if (textInputPos) {
            finalizeText();
        }
        setTextInputPos({ x, y });
        setInputTextValue("");
        return;
    }

    if (textInputPos) {
        finalizeText();
        return;
    }

    setDragStart({ x: e.clientX, y: e.clientY }); 
    
    if (currentTool === ToolType.SELECT) {
        if (selectedId) {
            const el = elements.find(el => el.id === selectedId);
            if (el && 'width' in el) {
                const handleSize = 15 / view.scale;
                const right = el.x + el.width;
                const bottom = el.y + el.height;
                if (x >= right - handleSize && x <= right + handleSize &&
                    y >= bottom - handleSize && y <= bottom + handleSize) {
                        setInteractionMode('resizing');
                        setActiveElementId(selectedId);
                        setIsDragging(true);
                        return;
                    }
            }
        }

        const hit = hitTest(x, y);
        if (hit) {
            setSelectedId(hit.id);
            setActiveElementId(hit.id);
            setInteractionMode('moving');
            setIsDragging(true);
        } else {
            setSelectedId(null);
            setInteractionMode('panning');
            setIsDragging(true);
        }

    } else if (currentTool === ToolType.PEN) {
      setInteractionMode('drawing');
      const newPath: PathElement = {
        id: Date.now().toString(),
        type: ElementType.PATH,
        x: 0, y: 0,
        color: currentColor,
        strokeWidth: 3,
        points: [{ x, y }]
      };
      setCurrentPath(newPath);
    } else if (currentTool === ToolType.RECTANGLE || currentTool === ToolType.CIRCLE) {
        setInteractionMode('drawing');
        const id = Date.now().toString();
        const newEl: CanvasElement = currentTool === ToolType.RECTANGLE
            ? { id, type: ElementType.RECT, x, y, width: 0, height: 0, color: currentColor }
            : { id, type: ElementType.CIRCLE, x, y, width: 0, height: 0, color: currentColor };
        
        setActiveElementId(id);
        setElements(prev => [...prev, newEl]);
    } else if (currentTool === ToolType.ERASER) {
        setInteractionMode('drawing');
        setIsDragging(true);
        eraseAt(x, y);
    }
  };

  const finalizeText = useCallback(() => {
      if (textInputPos && inputTextValue.trim()) {
          const newText: TextElement = {
              id: Date.now().toString(),
              type: ElementType.TEXT,
              x: textInputPos.x,
              y: textInputPos.y,
              text: inputTextValue,
              fontSize: 24,
              color: currentColor
          };
          const newElements = [...elements, newText];
          pushToHistory(newElements);
      }
      setTextInputPos(null);
      setInputTextValue("");
  }, [textInputPos, inputTextValue, currentColor, elements]);

  const eraseAt = (x: number, y: number) => {
    const radius = 20 / view.scale;
    const toRemove = new Set<string>();
    elements.forEach(el => {
        if ('width' in el) {
             const cx = el.x + el.width/2;
             const cy = el.y + el.height/2;
             if (Math.hypot(cx - x, cy - y) < radius + Math.min(el.width, el.height)/2) {
                 toRemove.add(el.id);
             }
        } else if (el.type === ElementType.TEXT) {
             if (Math.abs(el.x - x) < radius + 50 && Math.abs(el.y - y) < radius + 20) {
                 toRemove.add(el.id);
             }
        } else if (el.type === ElementType.PATH) {
            if (el.points && el.points.length) {
                for (const p of el.points) {
                    if (Math.hypot(p.x - x, p.y - y) < radius) {
                        toRemove.add(el.id);
                        break;
                    }
                }
            }
            if (el.pathData) {
                 if (Math.hypot(el.x - x, el.y - y) < radius + 50) toRemove.add(el.id);
            }
        }
    });

    if (toRemove.size > 0) {
        setElements(prev => prev.filter(el => !toRemove.has(el.id)));
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (requestRef.current) return;
    requestRef.current = requestAnimationFrame(() => {
        requestRef.current = undefined;
        const { x, y } = getPointerPos(e);

        if (currentTool === ToolType.PEN && currentPath) {
          setCurrentPath(prev => prev ? { ...prev, points: [...prev.points, { x, y }] } : null);
        } 
        else if (currentTool === ToolType.ERASER && isDragging) {
            eraseAt(x, y);
        }
        else if (interactionMode === 'panning') {
            setView(prev => ({ ...prev, x: prev.x - e.movementX / prev.scale, y: prev.y - e.movementY / prev.scale }));
        } 
        else if (interactionMode === 'moving' && activeElementId) {
            setElements(prev => prev.map(el => {
                if (el.id === activeElementId) {
                    if ('width' in el) {
                        return { ...el, x: el.x + e.movementX / view.scale, y: el.y + e.movementY / view.scale };
                    } else if (el.type === ElementType.PATH && el.points) {
                        return { 
                            ...el, 
                            points: el.points.map(p => ({ x: p.x + e.movementX / view.scale, y: p.y + e.movementY / view.scale }))
                        };
                    } else if (el.type === ElementType.PATH && el.pathData) {
                         return { ...el, x: el.x + e.movementX / view.scale, y: el.y + e.movementY / view.scale };
                    } else if (el.type === ElementType.TEXT) {
                         return { ...el, x: el.x + e.movementX / view.scale, y: el.y + e.movementY / view.scale };
                    }
                }
                return el;
            }));
        } 
        else if (interactionMode === 'resizing' && activeElementId) {
            setElements(prev => prev.map(el => {
                if (el.id === activeElementId && 'width' in el) {
                    const newWidth = Math.max(100, x - el.x);
                    const newHeight = Math.max(100, y - el.y);
                    return { ...el, width: newWidth, height: newHeight };
                }
                return el;
            }));
        }
        else if (interactionMode === 'drawing' && activeElementId && (currentTool === ToolType.RECTANGLE || currentTool === ToolType.CIRCLE)) {
             setElements(prev => prev.map(el => {
                if (el.id === activeElementId && 'width' in el) {
                     const newWidth = x - el.x;
                     const newHeight = y - el.y;
                     return { 
                         ...el, 
                         width: Math.abs(newWidth), 
                         height: Math.abs(newHeight),
                         x: newWidth < 0 ? x : el.x,
                         y: newHeight < 0 ? y : el.y
                     };
                }
                return el;
             }));
        }
    });
  };

  const handlePointerUp = () => {
    if (currentTool === ToolType.PEN && currentPath) {
      const newElements = [...elements, currentPath];
      pushToHistory(newElements);
      setCurrentPath(null);
    } else if (interactionMode !== 'idle' && interactionMode !== 'panning') {
        pushToHistory(elements);
    }
    
    setInteractionMode('idle');
    setIsDragging(false);
    setActiveElementId(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
        const scaleBy = 1.05;
        const newScale = e.deltaY > 0 ? view.scale / scaleBy : view.scale * scaleBy;
        const clampedScale = Math.max(0.1, Math.min(newScale, 5));
        setView(prev => ({ ...prev, scale: clampedScale }));
    } else {
        setView(prev => ({ ...prev, x: prev.x + e.deltaX / prev.scale, y: prev.y + e.deltaY / prev.scale }));
    }
  };

  const handleZoomIn = () => setView(prev => ({ ...prev, scale: Math.min(prev.scale * 1.2, 5) }));
  const handleZoomOut = () => setView(prev => ({ ...prev, scale: Math.max(prev.scale / 1.2, 0.1) }));

  useEffect(() => {
    if (textInputPos && textInputRef.current) {
        textInputRef.current.focus();
    }
  }, [textInputPos]);


  // --- Text Chat Logic ---
  const handleSendText = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!chatInputText.trim()) return;
      
      const prompt = chatInputText;
      setChatInputText("");
      setIsChatProcessing(true);

      try {
          if (!process.env.API_KEY) throw new Error("API Key missing");

          // Initialize chat session if not exists
          if (!chatSessionRef.current) {
              const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
              chatSessionRef.current = ai.chats.create({
                  model: MODEL_NAMES.THINKING, 
                  config: {
                      tools: [{ functionDeclarations: whiteboardTools }],
                      systemInstruction: "You are a helpful collaborative whiteboard assistant. You see the whiteboard. You can draw, write text/latex, create simulations, and generate images based on user requests."
                  }
              });
          }

          // Capture Screen
          const base64Image = await getScreenCapture();
          const messageParts: any[] = [{ text: prompt }];
          if (base64Image) {
             messageParts.push({ inlineData: { mimeType: 'image/jpeg', data: base64Image } });
          }

          // FIX: Pass messageParts directly, do not wrap in { parts: ... }
          const result = await chatSessionRef.current.sendMessage({ 
              message: messageParts 
          });
          
          const parts = result.candidates?.[0]?.content?.parts || [];
          const functionCalls = parts
              .filter(p => p.functionCall)
              .map(p => p.functionCall);
            
          if (functionCalls.length > 0) {
              const responses = await executeTools(functionCalls);
              
              const responseParts = responses.map(r => ({
                  functionResponse: { name: r.name, response: r.response }
              }));

              await chatSessionRef.current.sendMessage({
                  message: responseParts
              });
          }
      } catch (err) {
          console.error("Chat Error", err);
          alert("Failed to send message. See console.");
      } finally {
          setIsChatProcessing(false);
      }
  };


  // --- Live API Integration ---

  const connectToLiveAPI = async () => {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;

    try {
        if (!process.env.API_KEY) {
            alert("API Key not found in environment.");
            return;
        }

        if (window.aistudio && window.aistudio.hasSelectedApiKey) {
           const hasKey = await window.aistudio.hasSelectedApiKey();
           if (!hasKey) {
             await window.aistudio.openSelectKey();
           }
        }

        // Initialize Audio Contexts
        // inputContext uses default rate to avoid error. We resample manually.
        inputContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); 
        // outputContext for playback
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
                            const inputData = e.inputBuffer.getChannelData(0);
                            const currentRate = inputContextRef.current!.sampleRate;
                            
                            // Robust Resampling to 16kHz
                            const downsampledData = resampleTo16k(inputData, currentRate);
                            const pcmBlob = createBlob(downsampledData);
                            sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));

                            // Volume Calculation
                            let sum = 0;
                            // Use input data for volume viz
                            for (let i = 0; i < inputData.length; i+=10) { 
                                sum += inputData[i] * inputData[i];
                            }
                            const rms = Math.sqrt(sum / (inputData.length/10));
                            
                            // DISPATCH CUSTOM EVENT FOR VISUALIZER
                            // This prevents React re-renders for the whole app
                            window.dispatchEvent(new CustomEvent('audio-volume-update', { detail: rms }));
                        };
                        
                        source.connect(processor);
                        processor.connect(inputContextRef.current.destination);
                        scriptProcessorRef.current = processor;
                    }

                    // Start Smart Video Streaming Loop (Vision)
                    let lastSentVersion = -1;
                    videoIntervalRef.current = window.setInterval(async () => {
                        // Smart Check: Only capture if changed AND not currently dragging (performance)
                        // This prevents heavy serialization from blocking audio processing during interaction
                        if (canvasVersion.current === lastSentVersion || isDraggingRef.current) {
                            return;
                        }

                        const base64 = await getScreenCapture();
                        if (base64) {
                            lastSentVersion = canvasVersion.current;
                            sessionPromise.then(session => {
                                session.sendRealtimeInput({
                                    media: { mimeType: 'image/jpeg', data: base64 }
                                });
                            });
                        }
                    }, 3000); // 3 seconds interval is sufficient for whiteboard updates
                },
                onmessage: async (msg: LiveServerMessage) => {
                    const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                    if (audioData && audioContextRef.current) {
                        setAiState(s => ({ ...s, modelState: 'speaking' }));
                        const buffer = await decodeAudioData(
                            decodeAudio(audioData),
                            audioContextRef.current
                        );
                        
                        const source = audioContextRef.current.createBufferSource();
                        source.buffer = buffer;
                        source.connect(audioContextRef.current.destination);
                        
                        const now = audioContextRef.current.currentTime;
                        // Add small buffer to prevent glitching if packet arrives late
                        const start = Math.max(now, nextStartTime.current); 
                        source.start(start);
                        nextStartTime.current = start + buffer.duration;
                        
                        source.onended = () => {
                             if (audioContextRef.current && audioContextRef.current.currentTime >= nextStartTime.current - 0.1) {
                                 setAiState(s => ({ ...s, modelState: 'listening' }));
                             }
                        };
                    }

                    if (msg.toolCall) {
                        const responses = await executeTools(msg.toolCall.functionCalls);
                        sessionPromise.then(session => {
                            session.sendToolResponse({
                                functionResponses: responses as any
                            });
                        });
                    }
                },
                onclose: () => {
                    disconnect();
                },
                onerror: (e) => {
                    console.error("Live API Error", e);
                    disconnect();
                }
            },
            config: {
                responseModalities: [Modality.AUDIO],
                tools: [{ functionDeclarations: whiteboardTools }],
                systemInstruction: "You are a helpful collaborative whiteboard assistant. You see the whiteboard canvas in real-time. You can draw, write text/latex, create simulations, and generate images based on user requests. When the user asks you to look at something, you can see it via the video stream."
            }
        });
        liveSession.current = sessionPromise;

    } catch (err) {
        console.error("Connection failed", err);
        alert("Failed to connect to Live API. Check console for details.");
        isConnectingRef.current = false;
        disconnect();
    } finally {
        isConnectingRef.current = false;
    }
  };

  const disconnect = () => {
    if (liveSession.current) {
        // We catch potentially unhandled promise rejections if close() is called on failed connection
        liveSession.current.then((s: any) => s.close()).catch(() => {});
        liveSession.current = null;
    }
    if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
    }
    if (inputContextRef.current) {
        inputContextRef.current.close();
        inputContextRef.current = null;
    }
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
    }
    if (videoIntervalRef.current) {
        clearInterval(videoIntervalRef.current);
        videoIntervalRef.current = undefined;
    }
    setAiState(s => ({ ...s, isConnected: false, modelState: 'idle', volume: 0 }));
    isConnectingRef.current = false;
  };

  const toggleMic = () => {
      if (aiState.isConnected) disconnect();
      else connectToLiveAPI();
  };


  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            handleUndo();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
            e.preventDefault();
            handleRedo();
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [historyIndex, history]);

  // Memoize Canvas Content to prevent re-renders when only AI volume changes
  const canvasContent = useMemo(() => (
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

          {/* Render Elements */}
          {elements.map(el => {
            const isSelected = selectedId === el.id;
            
            if (el.type === ElementType.PATH) {
              let d = '';
              if (el.pathData) {
                  d = el.pathData;
              } else if (el.points && el.points.length > 0) {
                  d = `M ${el.points.map(p => `${p.x} ${p.y}`).join(' L ')}`;
              }
              if (!d) return null;

              return (
                <g key={el.id} className={isSelected ? 'opacity-80' : ''}>
                    <path d={d} stroke={el.color} strokeWidth={el.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    {isSelected && <path d={d} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 4" fill="none" className="pointer-events-none" />}
                </g>
              );
            }
            if (el.type === ElementType.RECT) {
              return (
                <g key={el.id}>
                    <rect x={el.x} y={el.y} width={el.width} height={el.height} fill={el.color} fillOpacity="0.2" stroke={el.color} strokeWidth="2" />
                    {isSelected && (
                        <>
                            <rect x={el.x-2} y={el.y-2} width={el.width+4} height={el.height+4} fill="none" stroke="#3b82f6" strokeWidth="1" strokeDasharray="4 4" />
                            <rect x={el.x + el.width - 5} y={el.y + el.height - 5} width="10" height="10" fill="#3b82f6" className="cursor-nwse-resize" />
                        </>
                    )}
                </g>
              );
            }
            if (el.type === ElementType.CIRCLE) {
              return (
                <g key={el.id}>
                    <circle cx={el.x + el.width/2} cy={el.y + el.height/2} r={el.width/2} fill={el.color} fillOpacity="0.2" stroke={el.color} strokeWidth="2" />
                    {isSelected && (
                        <>
                             <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth="1" strokeDasharray="4 4" />
                             <rect x={el.x + el.width - 5} y={el.y + el.height - 5} width="10" height="10" fill="#3b82f6" className="cursor-nwse-resize" />
                        </>
                    )}
                </g>
              );
            }
            if (el.type === ElementType.IMAGE) {
              return (
                <g key={el.id}>
                    <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="overflow-visible pointer-events-none">
                        <div className="relative w-full h-full">
                            <img src={el.src} alt="AI Generated" className="w-full h-full object-cover rounded shadow-lg pointer-events-auto" />
                        </div>
                    </foreignObject>
                    {isSelected && (
                         <>
                            <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth="2" />
                            <rect x={el.x + el.width - 5} y={el.y + el.height - 5} width="10" height="10" fill="#3b82f6" className="cursor-nwse-resize" />
                         </>
                    )}
                </g>
              );
            }
            if (el.type === ElementType.TEXT) {
                return (
                    <g key={el.id}>
                        <foreignObject x={el.x} y={el.y} width={500} height={500} className="overflow-visible pointer-events-none">
                             <div className="pointer-events-auto">
                                <TextNode text={el.text} color={el.color} fontSize={el.fontSize} />
                             </div>
                        </foreignObject>
                         {isSelected && (
                             <rect x={el.x - 5} y={el.y - 5} width={10} height={10} fill="#3b82f6" className="cursor-move" />
                         )}
                    </g>
                )
            }
            if (el.type === ElementType.SIMULATION) {
                return (
                    <g key={el.id}>
                        <foreignObject x={el.x} y={el.y} width={el.width} height={el.height} className="overflow-visible">
                            <div className="w-full h-full shadow-md">
                                <SimulationNode 
                                    code={el.code} 
                                    title={el.title} 
                                    width={el.width} 
                                    height={el.height} 
                                    selected={isSelected}
                                />
                            </div>
                        </foreignObject>
                         {isSelected && (
                             <>
                                <rect x={el.x} y={el.y} width={el.width} height={el.height} fill="none" stroke="#3b82f6" strokeWidth="2" pointerEvents="none" />
                                <rect x={el.x + el.width - 5} y={el.y + el.height - 5} width="10" height="10" fill="#3b82f6" className="cursor-nwse-resize" />
                             </>
                         )}
                    </g>
                )
            }
            return null;
          })}

          {/* Current Drawing Path */}
          {currentPath && (
            <path 
              d={`M ${currentPath.points.map(p => `${p.x} ${p.y}`).join(' L ')}`} 
              stroke={currentPath.color} 
              strokeWidth={currentPath.strokeWidth} 
              fill="none" 
              strokeLinecap="round" 
              strokeLinejoin="round" 
            />
          )}

          {/* Text Input Overlay */}
          {textInputPos && (
             <foreignObject x={textInputPos.x} y={textInputPos.y} width={300} height={150}>
                 <textarea
                    ref={textInputRef}
                    className="w-full h-full bg-transparent border-2 border-blue-500 rounded p-1 outline-none resize-none overflow-hidden"
                    style={{ fontSize: '24px', color: currentColor }}
                    value={inputTextValue}
                    onChange={(e) => setInputTextValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            finalizeText(); // App.tsx function to create text element
                        }
                    }}
                    placeholder="Type math ($...$) or text..."
                 />
             </foreignObject>
          )}

        </svg>
  ), [elements, view, currentPath, selectedId, textInputPos, inputTextValue, currentColor, finalizeText]);

  return (
    <div className="w-full h-screen overflow-hidden relative bg-gray-50 touch-none select-none">
      {/* Infinite Canvas Wrapper */}
      <div 
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
      >
        {canvasContent}
      </div>

      <Toolbar 
        currentTool={currentTool} 
        setTool={setTool} 
        currentColor={currentColor}
        setColor={setColor}
        aiState={aiState}
        onToggleMic={toggleMic}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        canUndo={historyIndex > 0}
        canRedo={historyIndex < history.length - 1}
      />

      {/* Text Chat Overlay */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 pointer-events-none">
         <form onSubmit={handleSendText} className="pointer-events-auto flex items-center gap-2 bg-white/95 backdrop-blur-md p-2 rounded-full shadow-2xl border border-gray-200 transition-all focus-within:ring-2 focus-within:ring-blue-500/50">
             <div className="pl-3 text-gray-400">
                <MessageSquare size={20} />
             </div>
             <input 
                type="text" 
                value={chatInputText}
                onChange={e => setChatInputText(e.target.value)}
                placeholder="Message Gemini to draw or simulate..."
                disabled={isChatProcessing}
                className="flex-1 bg-transparent border-none focus:ring-0 text-gray-800 placeholder-gray-500 text-sm py-2 disabled:opacity-50"
             />
             <button 
                type="submit"
                disabled={!chatInputText.trim() || isChatProcessing}
                className={`p-2 rounded-full transition-colors flex items-center justify-center ${
                    !chatInputText.trim() || isChatProcessing ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
             >
                {isChatProcessing ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
             </button>
         </form>
      </div>

      {/* Intro Overlay */}
      {elements.length === 0 && !aiState.isConnected && history.length <= 1 && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none opacity-40 select-none">
           <h1 className="text-4xl font-bold text-gray-800 mb-2">Infinite Mind Canvas</h1>
           <p className="text-xl text-gray-600">Draw, speak, and collaborate with AI.</p>
           <p className="mt-4 text-sm">Click the microphone to start Live Audio, or type a command below.</p>
        </div>
      )}
    </div>
  );
};

export default App;