import React, { useMemo, useState } from 'react';
import { Lock, Unlock, Move } from 'lucide-react';

interface SimulationNodeProps {
  code: string;
  width: number;
  height: number;
  title: string;
  selected: boolean;
}

export const SimulationNode: React.FC<SimulationNodeProps> = ({ code, width, height, title, selected }) => {
  // If we are selecting/moving (indicated by 'selected' prop usually handled by parent, 
  // but we also need local state to toggle interaction with iframe vs moving the box).
  const [isInteractive, setIsInteractive] = useState(false);

  // Inject MathJax and Tailwind into the iframe environment
  const srcDoc = useMemo(() => `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <script src="https://cdn.tailwindcss.com"></script>
        <script>
          window.MathJax = {
            tex: { inlineMath: [['$', '$'], ['\\(', '\\)']] },
            svg: { fontCache: 'global' }
          };
        </script>
        <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
        <style>
          body { background-color: white; margin: 0; padding: 1rem; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
          /* Allow text selection inside */
        </style>
      </head>
      <body>
        ${code}
      </body>
    </html>
  `, [code]);

  return (
    <div 
      className={`relative bg-white rounded-lg shadow-xl overflow-hidden border-2 flex flex-col transition-shadow ${selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-300'}`}
      style={{ width, height }}
    >
      {/* Header Bar */}
      <div className="bg-gray-100 px-3 py-1.5 border-b border-gray-200 flex justify-between items-center select-none">
        <span className="font-semibold text-xs text-gray-700 flex items-center gap-1">
           {title}
        </span>
        <div className="flex gap-2">
            <button 
                onPointerDown={(e) => { e.stopPropagation(); setIsInteractive(!isInteractive); }}
                className={`p-1 rounded hover:bg-gray-200 transition-colors ${isInteractive ? 'text-green-600' : 'text-gray-500'}`}
                title={isInteractive ? "Click to lock (enable moving)" : "Click to interact"}
            >
                {isInteractive ? <Unlock size={14} /> : <Lock size={14} />}
            </button>
        </div>
      </div>

      <div className="flex-1 relative bg-white">
        <iframe
          srcDoc={srcDoc}
          className="w-full h-full border-none block"
          title={title}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin"
        />
        
        {/* Interaction Blocker Overlay: 
            If NOT interactive, this overlay catches clicks/drags to allow moving the parent node via App.tsx logic. 
            If interactive, this overlay is hidden so iframe gets events. 
        */}
        {!isInteractive && (
            <div className="absolute inset-0 bg-transparent cursor-move" />
        )}
      </div>

      {/* Resize Handle Indicator (Visual Only, logic in App.tsx) */}
      {selected && !isInteractive && (
          <div className="absolute bottom-0 right-0 p-1 cursor-nwse-resize">
              <div className="w-4 h-4 bg-blue-500 rounded-tl-lg opacity-50 hover:opacity-100" />
          </div>
      )}
    </div>
  );
};