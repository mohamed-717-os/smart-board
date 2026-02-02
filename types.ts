
export enum ToolType {
  SELECT = 'select',
  PAN = 'pan',
  PEN = 'pen',
  LINE = 'line',
  RECTANGLE = 'rect',
  TRIANGLE = 'triangle',
  CIRCLE = 'circle',
  TEXT = 'text',
  ERASER = 'eraser',
}

export enum ElementType {
  PATH = 'path',
  LINE = 'line',
  RECT = 'rect',
  TRIANGLE = 'triangle',
  CIRCLE = 'circle',
  IMAGE = 'image',
  TEXT = 'text',
  SIMULATION = 'simulation',
}

export interface Point {
  x: number;
  y: number;
}

export interface BaseElement {
  id: string;
  x: number;
  y: number;
  rotation?: number;
  color: string;
  filled?: boolean; // New: Solid vs Transparent
}

export interface PathElement extends BaseElement {
  type: ElementType.PATH;
  points: Point[];     // Used for user drawing
  pathData?: string;   // Used for AI drawing (SVG d string)
  strokeWidth: number;
}

// Line is simple start/end
export interface LineElement extends BaseElement {
    type: ElementType.LINE;
    x2: number;
    y2: number;
    strokeWidth: number;
}

export interface ShapeElement extends BaseElement {
  type: ElementType.RECT | ElementType.CIRCLE | ElementType.TRIANGLE;
  width: number;
  height: number;
  // For triangle, x/y is bounding box top-left
}

export interface ImageElement extends BaseElement {
  type: ElementType.IMAGE;
  width: number;
  height: number;
  src: string;
  prompt?: string;
}

export interface TextElement extends BaseElement {
  type: ElementType.TEXT;
  text: string;
  fontSize: number;
}

export interface SimulationElement extends BaseElement {
  type: ElementType.SIMULATION;
  width: number;
  height: number;
  code: string; // HTML/JS content
  title: string;
}

export type CanvasElement = PathElement | LineElement | ShapeElement | ImageElement | TextElement | SimulationElement;

export interface ViewState {
  x: number;
  y: number;
  scale: number;
}

export interface AIState {
  isConnected: boolean;
  isListening: boolean;
  modelState: 'idle' | 'listening' | 'thinking' | 'speaking';
}
