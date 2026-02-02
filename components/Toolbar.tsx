import React, { useEffect, useState } from 'react';
import { ToolType, AIState } from '../types';
import { COLORS } from '../constants';
import { 
  MousePointer2, 
  Hand,
  Pencil, 
  Minus,
  Triangle,
  Square, 
  Circle, 
  Eraser, 
  Mic, 
  MicOff,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Type as TypeIcon,
  BoxSelect,
  Loader2,
  Image as ImageIcon,
  Trash2
} from 'lucide-react';

interface ToolbarProps {
  currentTool: ToolType;
  setTool: (t: ToolType) => void;
  currentColor: string;
  setColor: (c: string) => void;
  filled: boolean;
  setFilled: (f: boolean) => void;
  aiState: AIState;
  isAIProcessing: boolean;
  onToggleMic: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  onImageUpload: () => void;
  onDelete: () => void;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

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
        <div className="flex gap-0.5 h-6 items-end justify-center px-1">
            {[1, 2, 3].map(i => {
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
                        className={`w-1 rounded-full transition-all duration-100 ease-out ${isSpeaking ? 'bg-indigo-400' : 'bg-emerald-400'}`}
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
  filled,
  setFilled,
  aiState,
  isAIProcessing,
  onToggleMic,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onFitView,
  onImageUpload,
  onDelete,
  hasSelection,
  canUndo,
  canRedo
}) => {
  
  const ToolButton = ({ tool, icon: Icon, label, onClick, isActive }: { tool?: ToolType, icon: any, label: string, onClick?: () => void, isActive?: boolean }) => (
    <button 
      onClick={onClick || (() => tool && setTool(tool))} 
      className={`group relative p-2 rounded-lg transition-all flex items-center justify-center ${
        isActive || currentTool === tool
          ? 'bg-blue-600 text-white shadow-sm'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
      title={label}
    >
      <Icon size={20} />
    </button>
  );

  return (
    <>
      {/* LEFT TOOLBAR: Creation Tools */}
      <div className="fixed left-3 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-40">
        <div className="flex flex-col gap-1 p-1.5 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-200">
             <ToolButton tool={ToolType.SELECT} icon={MousePointer2} label="Select (V)" />
             <ToolButton tool={ToolType.PAN} icon={Hand} label="Pan View (H)" />
             <div className="w-full h-px bg-gray-100 my-0.5" />
             <ToolButton tool={ToolType.PEN} icon={Pencil} label="Pencil (P)" />
             <ToolButton tool={ToolType.TEXT} icon={TypeIcon} label="Text (T)" />
             <ToolButton tool={ToolType.ERASER} icon={Eraser} label="Eraser (E)" />
             <div className="w-full h-px bg-gray-100 my-0.5" />
             <ToolButton tool={ToolType.LINE} icon={Minus} label="Line" />
             <ToolButton tool={ToolType.RECTANGLE} icon={Square} label="Rectangle" />
             <ToolButton tool={ToolType.CIRCLE} icon={Circle} label="Circle" />
             <ToolButton tool={ToolType.TRIANGLE} icon={Triangle} label="Triangle" />
             <ToolButton icon={ImageIcon} label="Upload Image" onClick={onImageUpload} isActive={false} />
        </div>
        
        {/* Undo/Redo Group */}
        <div className="flex flex-col gap-1 p-1.5 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-200">
             <button onClick={onUndo} disabled={!canUndo} className={`p-2 rounded hover:bg-gray-100 text-gray-700 ${!canUndo && 'opacity-30'}`}><Undo2 size={20} /></button>
             <button onClick={onRedo} disabled={!canRedo} className={`p-2 rounded hover:bg-gray-100 text-gray-700 ${!canRedo && 'opacity-30'}`}><Redo2 size={20} /></button>
        </div>
      </div>

      {/* RIGHT TOOLBAR: Properties & AI */}
      <div className="fixed right-3 top-1/2 -translate-y-1/2 flex flex-col gap-3 z-40 items-end">
        
        {/* Gemini Live Button */}
        <div className="flex flex-col items-center p-2 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-200 transition-all duration-300">
           <button
              onClick={onToggleMic}
              className={`
                  w-10 h-10 rounded-full flex items-center justify-center transition-all
                  ${aiState.isConnected ? 'bg-red-500 hover:bg-red-600 shadow-red-200' : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200'}
                  text-white shadow-lg
              `}
              title={aiState.isConnected ? "Disconnect Live" : "Connect Gemini Live"}
           >
              {aiState.isConnected ? <MicOff size={20} /> : <Mic size={20} />}
           </button>
           
           {aiState.isConnected && (
               <div className="mt-2 w-full flex justify-center">
                   <AudioVisualizer isSpeaking={aiState.modelState === 'speaking'} />
               </div>
           )}

           {isAIProcessing && (
              <div className="mt-2 animate-spin text-blue-600"><Loader2 size={16} /></div>
           )}
        </div>

        {/* Object Properties (Color, Fill) */}
        <div className="flex flex-col gap-2 p-2 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-200">
             <div className="grid grid-cols-2 gap-2">
                {COLORS.slice(0, 8).map((c) => (
                    <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full border border-black/10 transition-transform ${
                        currentColor === c ? 'ring-2 ring-offset-2 ring-gray-900 scale-110' : ''
                    }`}
                    style={{ backgroundColor: c }}
                    />
                ))}
             </div>
             <div className="w-full h-px bg-gray-200" />
             <div className="flex gap-2 justify-center">
                 <button
                    onClick={() => setFilled(!filled)}
                    className={`p-1.5 rounded-md transition-colors ${filled ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-800'}`}
                    title={filled ? "Solid Fill" : "Outline Only"}
                >
                    {filled ? <BoxSelect size={18} fill="currentColor" /> : <BoxSelect size={18} />}
                </button>
                {hasSelection && (
                     <button
                        onClick={onDelete}
                        className="p-1.5 rounded-md bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                        title="Delete Selected"
                    >
                        <Trash2 size={18} />
                    </button>
                )}
             </div>
        </div>

        {/* View Controls */}
        <div className="flex flex-col gap-1 p-1.5 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-200">
             <button onClick={onZoomIn} className="p-2 rounded hover:bg-gray-100 text-gray-700"><ZoomIn size={20} /></button>
             <button onClick={onZoomOut} className="p-2 rounded hover:bg-gray-100 text-gray-700"><ZoomOut size={20} /></button>
             <button onClick={onFitView} className="p-2 rounded hover:bg-gray-100 text-gray-700"><Maximize size={20} /></button>
        </div>

      </div>
    </>
  );
};