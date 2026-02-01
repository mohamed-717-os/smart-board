import { FunctionDeclaration, Type } from "@google/genai";

export const MODEL_NAMES = {
  LIVE: 'gemini-2.5-flash-native-audio-preview-12-2025',
  IMAGE_GEN: 'gemini-3-pro-image-preview', // "Nano Banana 3" equivalent for HQ
  THINKING: 'gemini-3-pro-preview',
};

// Tool Definitions for the Live API
export const whiteboardTools: FunctionDeclaration[] = [
  {
    name: 'draw_rectangle',
    description: 'Draws a rectangle on the whiteboard at a specific location.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'X coordinate' },
        y: { type: Type.NUMBER, description: 'Y coordinate' },
        width: { type: Type.NUMBER, description: 'Width of rectangle' },
        height: { type: Type.NUMBER, description: 'Height of rectangle' },
        color: { type: Type.STRING, description: 'Hex color code (e.g. #ff0000)' },
      },
      required: ['x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'draw_circle',
    description: 'Draws a circle on the whiteboard.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'Center X coordinate' },
        y: { type: Type.NUMBER, description: 'Center Y coordinate' },
        radius: { type: Type.NUMBER, description: 'Radius of circle' },
        color: { type: Type.STRING, description: 'Hex color code' },
      },
      required: ['x', 'y', 'radius', 'color'],
    },
  },
  {
    name: 'draw_path',
    description: 'Draws a freehand line or path on the whiteboard using an SVG path data string. Use this to write text, draw arrows, or sketch complex shapes.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pathData: { type: Type.STRING, description: 'SVG path "d" attribute string (e.g., "M10 10 L20 20 C...")' },
        color: { type: Type.STRING, description: 'Hex color code' },
        strokeWidth: { type: Type.NUMBER, description: 'Thickness of the stroke' },
      },
      required: ['pathData', 'color'],
    },
  },
  {
    name: 'write_text',
    description: 'Writes text or LaTeX equations on the whiteboard. Supports Markdown and LaTeX (wrapped in $).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'The text content or LaTeX string' },
        x: { type: Type.NUMBER, description: 'X position' },
        y: { type: Type.NUMBER, description: 'Y position' },
        color: { type: Type.STRING, description: 'Hex color code' },
      },
      required: ['text', 'x', 'y'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generates a high-quality image or diagram using the Nano Banana Pro agent based on a prompt.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'Detailed description of the image to generate' },
        size: { type: Type.STRING, description: 'Size of image: 1K, 2K, or 4K. Default to 1K.' },
        x: { type: Type.NUMBER, description: 'X position to place image' },
        y: { type: Type.NUMBER, description: 'Y position to place image' },
      },
      required: ['prompt', 'x', 'y'],
    },
  },
  {
    name: 'generate_simulation',
    description: 'Generates an interactive HTML/JS simulation. The code must be self-contained.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Title of the simulation' },
        code: { type: Type.STRING, description: 'Complete HTML body content. Do not include <html> or <head> tags, just the body content. Script tags are allowed.' },
        x: { type: Type.NUMBER, description: 'X position' },
        y: { type: Type.NUMBER, description: 'Y position' },
      },
      required: ['title', 'code', 'x', 'y'],
    },
  },
  {
    name: 'clear_board',
    description: 'Clears all elements from the whiteboard.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

export const COLORS = [
  '#000000', // Black
  '#ef4444', // Red
  '#22c55e', // Green
  '#3b82f6', // Blue
  '#eab308', // Yellow
  '#a855f7', // Purple
  '#ec4899', // Pink
  '#64748b', // Slate
];