
import { FunctionDeclaration, Type } from "@google/genai";

export const MODEL_NAMES = {
  LIVE: 'gemini-2.5-flash-native-audio-preview-12-2025',
  IMAGE_GEN: 'gemini-3-pro-image-preview', // High quality image gen
  THINKING: 'gemini-3-pro-preview', // Complex reasoning
};

export const whiteboardTools: FunctionDeclaration[] = [
  {
    name: 'draw_rectangle',
    description: 'Draws a rectangle.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'X coordinate' },
        y: { type: Type.NUMBER, description: 'Y coordinate' },
        width: { type: Type.NUMBER, description: 'Width' },
        height: { type: Type.NUMBER, description: 'Height' },
        color: { type: Type.STRING, description: 'Hex color' },
        filled: { type: Type.BOOLEAN, description: 'True for solid fill, False for transparent (outline only)' }
      },
      required: ['x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'draw_triangle',
    description: 'Draws a triangle.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'Bounding box X' },
        y: { type: Type.NUMBER, description: 'Bounding box Y' },
        width: { type: Type.NUMBER, description: 'Width' },
        height: { type: Type.NUMBER, description: 'Height' },
        color: { type: Type.STRING, description: 'Hex color' },
        filled: { type: Type.BOOLEAN, description: 'True for solid fill' }
      },
      required: ['x', 'y', 'width', 'height', 'color'],
    },
  },
  {
    name: 'draw_circle',
    description: 'Draws a circle.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'Center X' },
        y: { type: Type.NUMBER, description: 'Center Y' },
        radius: { type: Type.NUMBER, description: 'Radius' },
        color: { type: Type.STRING, description: 'Hex color' },
        filled: { type: Type.BOOLEAN, description: 'True for solid fill' }
      },
      required: ['x', 'y', 'radius', 'color'],
    },
  },
  {
    name: 'draw_line',
    description: 'Draws a straight line.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x1: { type: Type.NUMBER, description: 'Start X' },
        y1: { type: Type.NUMBER, description: 'Start Y' },
        x2: { type: Type.NUMBER, description: 'End X' },
        y2: { type: Type.NUMBER, description: 'End Y' },
        color: { type: Type.STRING, description: 'Hex color' },
        strokeWidth: { type: Type.NUMBER, description: 'Thickness' }
      },
      required: ['x1', 'y1', 'x2', 'y2', 'color'],
    },
  },
  {
    name: 'draw_path',
    description: 'Draws a freehand line/path using SVG d string. Use for text/arrows/sketches.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pathData: { type: Type.STRING, description: 'SVG d attribute' },
        color: { type: Type.STRING, description: 'Hex color' },
        strokeWidth: { type: Type.NUMBER, description: 'Thickness' },
      },
      required: ['pathData', 'color'],
    },
  },
  {
    name: 'write_text',
    description: 'Writes text or LaTeX.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'Text/LaTeX content' },
        x: { type: Type.NUMBER, description: 'X position' },
        y: { type: Type.NUMBER, description: 'Y position' },
        color: { type: Type.STRING, description: 'Hex color' },
      },
      required: ['text', 'x', 'y'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generates a high-quality image using Nano Banana (Imagen). Use this for complex scenes, diagrams, or photorealistic requests.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'Image description' },
        size: { type: Type.STRING, description: '1K, 2K, or 4K' },
        x: { type: Type.NUMBER, description: 'X position' },
        y: { type: Type.NUMBER, description: 'Y position' },
      },
      required: ['prompt', 'x', 'y'],
    },
  },
  {
    name: 'generate_simulation',
    description: 'Generates an interactive HTML/JS simulation using Gemini 3 capabilities. Use this for physics, math, or coding simulations.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Title' },
        code: { type: Type.STRING, description: 'HTML body content with script' },
        x: { type: Type.NUMBER, description: 'X position' },
        y: { type: Type.NUMBER, description: 'Y position' },
      },
      required: ['title', 'code', 'x', 'y'],
    },
  },
  {
    name: 'clear_board',
    description: 'Clears all elements.',
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
  '#ffffff', // White
];

export const SYSTEM_INSTRUCTION = `You are a smart, collaborative whiteboard agent.
- For simple actions (move objects, clear board, simple geometric shapes, simple sketches), perform them directly using the drawing tools.
- For complex visual requests (detailed art, complex diagrams, specific scenes), use the 'generate_image' tool (powered by Nano Banana).
- For interactive tasks (physics demos, coding, calculators), use the 'generate_simulation' tool (powered by Gemini 3).
- You can see the user's canvas. When asked to "look", analyze the video stream.
- Always choose the best tool for the job. Do not say "I can't do that", instead use the appropriate generator tool.`;
