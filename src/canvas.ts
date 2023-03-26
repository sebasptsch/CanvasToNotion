import { CanvasApi } from "api-canvas-ts";
import { config } from "dotenv";
import { getCanvasUrl, getCanvasKey } from ".";
config();

const TOKEN = await getCanvasKey()
const BASE = await getCanvasUrl()

export default new CanvasApi({
    TOKEN,
    BASE
})