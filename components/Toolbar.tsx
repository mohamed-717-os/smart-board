import React, { useEffect, useState, useRef } from 'react';
import { ToolType, AIState } from '../types';
import { COLORS } from '../constants';
import { 
  MousePointer2, 
  Pencil, 
  Square, 
  Circle, 
  Eraser, 
  Mic, 
  MicOff,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Type as TypeIcon
} from 'lucide-react';

interface ToolbarProps {
  currentTool: ToolType;
  setTool: (t: ToolType) => void;
  currentColor: string;
  setColor: (c: string) => void;
  aiState: AIState;
  onToggleMic: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

// Independent component to handle high-frequency volume updates
const AudioVisualizer: React.FC<{ isSpeaking: boolean }> = ({ isSpeaking }) => {
    const [volume, setVolume] = useState(0);

    useEffect(() => {
        const handleVolumeUpdate = (e: CustomEvent) => {
            setVolume(e.detail);
        };
        
        window.addEventListener('audio-volume-update', handleVolumeUpdate as EventListener);
        return () => window.removeEventListener('audio-volume-update', handleVolumeUpdate as EventListener);
    }, []);

    return (
        <div className="flex gap-1 h-8 items-end justify-center w-full px-1 mb-1">
            {[1, 2, 3, 4].map(i => {
                let heightPerc = 20;
                if (isSpeaking) {
                    heightPerc = 40 + (volume * 100 * (i % 2 === 0 ? 1 : 0.5));
                } else {
                    heightPerc = 20 + (volume * 400 * (1 - i * 0.1));
                }
                const height = `${Math.min(100, Math.max(20, heightPerc))}%`;

                return (
                    <div
                        key={i}
                        className={`w-1.5 rounded-full transition-all duration-100 ease-out ${isSpeaking ? 'bg-indigo-400' : 'bg-emerald-400'}`}
                        style={{ height }}
                    />
                );
            })}
        </div>
    );
};

export const Toolbar: React.FC<ToolbarProps> = ({
  currentTool,
  setTool,
  currentColor,
  setColor,
  aiState,
  onToggleMic,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  canUndo,
  canRedo
}) => {
  
  const ToolButton = ({ tool, icon: Icon, label }: { tool: ToolType, icon: any, label: string }) => (
    <button 
      onClick={() => setTool(tool)} 
      className={`group relative p-2.5 rounded-xl transition-all w-full flex items-center justify-center ${
        currentTool === tool
          ? 'bg-blue-600 text-white shadow-md'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      <Icon size={20} />
      {/* Tooltip */}
      <span className="absolute left-full ml-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
        {label}
      </span>
    </button>
  );

  return (
    <div className="fixed left-4 top-1/2 -translate-y-1/2 flex flex-col gap-4 z-40 pointer-events-none select-none">
      
      {/* AI Control */}
      <div className="flex flex-col items-center p-3 bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-gray-200 pointer-events-auto transition-all duration-300">
         <button
            onClick={onToggleMic}
            className={`
                w-12 h-12 rounded-full flex items-center justify-center transition-all mb-2
                ${aiState.isConnected ? 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-200' : 'bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200'}
                text-white
            `}
            title={aiState.isConnected ? "Disconnect Live" : "Connect Gemini Live"}
         >
            {aiState.isConnected ? <MicOff size={24} /> : <Mic size={24} />}
         </button>

         {aiState.isConnected && <AudioVisualizer isSpeaking={aiState.modelState === 'speaking'} />}
         
         <span className="text-[9px] font-bold tracking-widest uppercase text-gray-400">
             {aiState.isConnected ? (aiState.modelState === 'speaking' ? 'TALKING' : 'LISTENING') : 'OFFLINE'}
         </span>
      </div>

      {/* Main Tools Group */}
      <div className="flex flex-col items-center gap-1 p-2 bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-gray-200 pointer-events-auto">
         
         <div className="flex flex-col gap-1 w-full border-b border-gray-100 pb-2 mb-1">
             <div className="flex gap-1">
                <button onClick={onUndo} disabled={!canUndo} className={`flex-1 p-2 rounded hover:bg-gray-100 flex justify-center text-gray-700 ${!canUndo && 'opacity-30'}`} title="Undo (Ctrl+Z)">
                    <Undo2 size={18} />
                </button>
                <button onClick={onRedo} disabled={!canRedo} className={`flex-1 p-2 rounded hover:bg-gray-100 flex justify-center text-gray-700 ${!canRedo && 'opacity-30'}`} title="Redo (Ctrl+Y)">
                    <Redo2 size={18} />
                </button>
             </div>
         </div>

         <ToolButton tool={ToolType.SELECT} icon={MousePointer2} label="Select & Move" />
         <ToolButton tool={ToolType.PEN} icon={Pencil} label="Pencil" />
         <ToolButton tool={ToolType.TEXT} icon={TypeIcon} label="Text / Math" />
         <ToolButton tool={ToolType.RECTANGLE} icon={Square} label="Rectangle" />
         <ToolButton tool={ToolType.CIRCLE} icon={Circle} label="Circle" />
         <ToolButton tool={ToolType.ERASER} icon={Eraser} label="Eraser" />

         <div className="flex flex-col gap-1 w-full border-t border-gray-100 pt-2 mt-1">
             <button onClick={onZoomIn} className="p-2 rounded hover:bg-gray-100 flex justify-center text-gray-700" title="Zoom In">
                <ZoomIn size={18} />
             </button>
             <button onClick={onZoomOut} className="p-2 rounded hover:bg-gray-100 flex justify-center text-gray-700" title="Zoom Out">
                <ZoomOut size={18} />
             </button>
         </div>
      </div>

      {/* Colors Group */}
      <div className="flex flex-col items-center gap-2 p-3 bg-white/95 backdrop-blur-md rounded-2xl shadow-xl border border-gray-200 pointer-events-auto">
        {COLORS.map((c) => (
            <button
            key={c}
            onClick={() => setColor(c)}
            className={`w-5 h-5 rounded-full border border-black/10 transition-transform hover:scale-110 ${
                currentColor === c ? 'ring-2 ring-offset-2 ring-gray-900 scale-110' : ''
            }`}
            style={{ backgroundColor: c }}
            aria-label={`Select color ${c}`}
            />
        ))}
      </div>

    </div>
  );
};