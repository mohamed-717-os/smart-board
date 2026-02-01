import { GoogleGenAI } from "@google/genai";
import { MODEL_NAMES } from "../constants";

export const generateImageContent = async (prompt: string, size: "1K" | "2K" | "4K" = "1K"): Promise<string | null> => {
  try {
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API Key missing");
    
    // We check for key selection for Pro models as per guidelines
    if (window.aistudio && window.aistudio.hasSelectedApiKey) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
         // The main App flow handles key selection, but purely defensive here
         return null;
      }
    }

    const ai = new GoogleGenAI({ apiKey });
    
    const response = await ai.models.generateContent({
      model: MODEL_NAMES.IMAGE_GEN,
      contents: {
        parts: [{ text: prompt }]
      },
      config: {
        imageConfig: {
          imageSize: size,
          aspectRatio: "1:1"
        }
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
