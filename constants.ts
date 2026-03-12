
import { FunctionDeclaration, Type } from "@google/genai";

export const MODEL_NAMES = {
  LIVE: 'gemini-2.0-flash-exp',
  IMAGE_GEN: 'gemini-3-pro-image-preview', // High quality image gen
  THINKING: 'gemini-3-pro-preview', // Complex reasoning
};

export const whiteboardTools: FunctionDeclaration[] = [
  {
    name: 'pan_view',
    description: 'Moves the view (camera) to a specific location on the board. Use this when you add new elements to ensure the user sees them.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'Target Center X' },
        y: { type: Type.NUMBER, description: 'Target Center Y' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'move_element_at',
    description: 'Moves an element found at a specific location to a new location. Use this when asked to move something the user is pointing at or describing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'Current X location of the element' },
        y: { type: Type.NUMBER, description: 'Current Y location of the element' },
        new_x: { type: Type.NUMBER, description: 'New X location' },
        new_y: { type: Type.NUMBER, description: 'New Y location' },
      },
      required: ['x', 'y', 'new_x', 'new_y'],
    },
  },
  {
    name: 'delete_element_at',
    description: 'Deletes an element found at a specific location.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER, description: 'X location of the element to delete' },
        y: { type: Type.NUMBER, description: 'Y location of the element to delete' },
      },
      required: ['x', 'y'],
    },
  },
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
    description: 'Generates a high-quality raster image using Nano Banana (Imagen). Use this for complex scenes, artistic requests, or photorealistic images.',
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
    description: 'Generates an interactive HTML/JS simulation. Use this for physics demos, math visualizations, or coding tasks. This calls Gemini 3.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Title' },
        prompt: { type: Type.STRING, description: 'Description of the simulation behavior' },
        x: { type: Type.NUMBER, description: 'X position' },
        y: { type: Type.NUMBER, description: 'Y position' },
      },
      required: ['title', 'prompt', 'x', 'y'],
    },
  },
  {
    name: 'generate_vector_drawing',
    description: 'Generates a complex vector drawing (flowcharts, diagrams, house plans) using Gemini 3. Use this when you need "complete shapes" or structured diagrams that are too complex to draw manually but should remain editable.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'Description of what to draw' },
        x: { type: Type.NUMBER, description: 'X position' },
        y: { type: Type.NUMBER, description: 'Y position' },
      },
      required: ['prompt', 'x', 'y'],
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
- **View Control**: If you create content outside the current view, use 'pan_view' to move the camera to it.
- **Manipulation**: Use 'move_element_at' and 'delete_element_at' to modify existing items.
- **Simple Actions**: For simple shapes, text, or moving objects, perform them directly.
- **Complex Vectors**: For structured diagrams (flowcharts, architecture, complex shapes), use 'generate_vector_drawing' (Calls Gemini 3).
- **Raster Images**: For artistic, photorealistic, or very complex scenes, use 'generate_image' (Calls Imagen).
- **Simulations**: For interactive code, physics, or math demos, use 'generate_simulation' (Calls Gemini 3).
- Always choose the best tool. Do not say "I can't", delegate to the generator tools.`;
