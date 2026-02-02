import { GoogleGenAI } from "@google/genai";
import { MODEL_NAMES } from "../constants";

const getApiKey = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API Key missing");
    if (window.aistudio && window.aistudio.hasSelectedApiKey) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) return null;
    }
    return apiKey;
};

export const generateImageContent = async (prompt: string, size: "1K" | "2K" | "4K" = "1K"): Promise<string | null> => {
  try {
    const apiKey = await getApiKey();
    if (!apiKey) return null;

    const ai = new GoogleGenAI({ apiKey });
    // Append minimal/clean style request to match whiteboard aesthetic
    const fullPrompt = `${prompt}. Minimalist style, isolated subject on white background if possible, high quality.`;
    
    const response = await ai.models.generateContent({
      model: MODEL_NAMES.IMAGE_GEN,
      contents: { parts: [{ text: fullPrompt }] },
      config: {
        imageConfig: { imageSize: size, aspectRatio: "1:1" }
      }
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }
    return null;
  } catch (error) {
    console.error("Image generation failed:", error);
    return null;
  }
};

export const generateSimulationCode = async (prompt: string): Promise<string | null> => {
    try {
        const apiKey = await getApiKey();
        if (!apiKey) return null;

        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: MODEL_NAMES.THINKING,
            contents: { 
                parts: [{ text: `Create a self-contained, interactive HTML/JS simulation for: "${prompt}". 
                - Use Tailwind CSS for styling.
                - Important: Use a clean, modern design with a WHITE background (bg-white) and dark text (text-slate-900) to fit a light-mode whiteboard.
                - It must fit within a 500x400px container.
                - Return ONLY the HTML code (no markdown fences). 
                - Ensure it is visually appealing and interactive.` }] 
            }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return null;
        
        // Clean markdown if present
        return text.replace(/```html/g, '').replace(/```/g, '').trim();
    } catch (error) {
        console.error("Simulation generation failed:", error);
        return null;
    }
};

export const generateVectorDrawing = async (prompt: string): Promise<any[] | null> => {
    try {
        const apiKey = await getApiKey();
        if (!apiKey) return null;

        const ai = new GoogleGenAI({ apiKey });
        
        // We ask Gemini 3 to return a JSON list of our tool calls to construct the drawing
        const response = await ai.models.generateContent({
            model: MODEL_NAMES.THINKING,
            contents: {
                parts: [{ text: `Generate a vector drawing for: "${prompt}".
                Return a JSON object with a "elements" property containing an array of shapes.
                Supported shapes:
                - { type: "rect", x, y, width, height, color, filled }
                - { type: "circle", x, y, radius, color, filled }
                - { type: "triangle", x, y, width, height, color, filled }
                - { type: "line", x1, y1, x2, y2, color, strokeWidth }
                - { type: "path", pathData, color, strokeWidth }
                
                Coordinates should be relative to (0,0) as the top-left of the drawing.
                Style Guide: Use neutral, professional colors (Slate, Blue, Black) that look good on a white background. Avoid neon or overly bright colors unless necessary.
                Output ONLY JSON.` }]
            },
            config: {
                responseMimeType: "application/json"
            }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return null;
        
        const json = JSON.parse(text);
        return json.elements || [];
    } catch (error) {
        console.error("Vector generation failed:", error);
        return null;
    }
};