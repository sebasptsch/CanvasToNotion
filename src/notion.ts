import { Client , LogLevel} from "@notionhq/client";
import { config } from "dotenv";
import { getNotionKey } from "."

config();

const notionKey = await getNotionKey()

export default new Client({ auth: notionKey, logLevel: LogLevel.ERROR });