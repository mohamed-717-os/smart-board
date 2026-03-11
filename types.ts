
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
  filled?: boolean;
  isLoading?: boolean; // New: For background generation state
}

export interface PathElement extends BaseElement {
  type: ElementType.PATH;
  points: Point[];
  pathData?: string;
  strokeWidth: number;
}

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
  code: string;
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
  modelState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'connecting';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
}
