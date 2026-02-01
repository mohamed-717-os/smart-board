import React, { useEffect, useRef } from 'react';

interface TextNodeProps {
  text: string;
  color: string;
  fontSize: number;
}

export const TextNode: React.FC<TextNodeProps> = ({ text, color, fontSize }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current && (window as any).MathJax) {
      // Clear previous content to avoid duplicating
      containerRef.current.innerHTML = text;
      // Trigger MathJax typeset
      (window as any).MathJax.typesetPromise([containerRef.current]).catch((err: any) => console.log(err));
    }
  }, [text]);

  return (
    <div 
      ref={containerRef}
      className="inline-block whitespace-pre-wrap font-sans"
      style={{ 
        color, 
        fontSize: `${fontSize}px`, 
        lineHeight: 1.5,
        minWidth: '20px',
        minHeight: '20px'
      }}
    />
  );
};