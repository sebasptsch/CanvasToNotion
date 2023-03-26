import { Client, isNotionClientError } from "@notionhq/client";
import {
  CreatePageParameters,
  DatabaseObjectResponse,
  PageObjectResponse,
  UpdatePageParameters,
} from "@notionhq/client/build/src/api-endpoints.js";
import { config } from "dotenv";
import inquirer from "inquirer";
import canvas from "./canvas";
import { Assignment } from "api-canvas-ts";
import logger from "./logger";
import notion from "./notion";

config();

try {
  logger.info("Starting script");
  const databaseId = await getDatabase();

  const courses = await getCourses();

  const assignments = await getAssignments(courses);

  const newEntries = assignments
    .filter((assignment) => assignment.name !== "SYS_EXCEPTION_GRADE")
    .map(assignmentToNewPage);

  const existingAssignments = await getExistingAssignments(databaseId);

  const updatedEntries = assignments
    .filter((assignment) => assignment.name !== "SYS_EXCEPTION_GRADE" && !!existingAssignments.assignmentIds.find(
      (assignmentObj) =>
        assignmentObj.assignmentId === assignment.id?.toString()
    ))
    .map((assignment) => {
      const pageId = existingAssignments.assignmentIds.find(
        (assignmentObj) =>
          assignmentObj.assignmentId === assignment.id?.toString()
      )!.pageId!;

      return {
        ...assignment,
        pageId,
      };
    })
    .map(assignmentToUpdatedPage);

  const toCreate = newEntries.filter(
    (entry) =>
      !existingAssignments.assignmentIds
        .map((assignmentObj) => assignmentObj.assignmentId)
        .includes(entry["Assignment Id"].number.toString())
  );

  const newPages = await Promise.all(
    toCreate.map((page) =>
      notion.pages.create({
        parent: {
          database_id: databaseId,
        },
        properties: page,
      })
    )
  );

  const updatedPages = await Promise.all(
    updatedEntries.map((page) =>
      notion.pages.update({
        page_id: page.page_id,
        properties: {
          "Due Date": page.properties["Due Date"],
        },
      })
    )
  );

  const newPageCount = newPages.filter(Boolean).map((page) => page!.id).length;
  const updatedPageCount = updatedPages.filter(Boolean).map((page) => page!.id).length;

  logger.success(
    `Successfully added ${newPageCount} new assignments and updated ${updatedPageCount} assignments`
  );
} catch (error) {
  if (isNotionClientError(error)) logger.error("Notion Error", error.message);
  else logger.error(error);
}

async function getExistingAssignments(databaseId: string) {
  const pages = await notion.databases.query({
    database_id: databaseId,
  });

  const pagesWithProperties = pages.results.filter((page) =>
    Object.hasOwn(page, "properties")
  ) as PageObjectResponse[];

  const pageIds = pagesWithProperties.map((page) => page.id);

  const assignmentIds: Array<{
    pageId: string;
    assignmentId: string;
  }> = [];

  for (const assignment of pagesWithProperties) {
    const assignmentIdProperty = assignment["properties"]["Assignment Id"];

    if (assignmentIdProperty?.type !== "number") continue;

    if (assignmentIdProperty.number)
      assignmentIds.push({
        assignmentId: assignmentIdProperty.number.toString(),
        pageId: assignment.id,
      });
  }

  return {
    pageIds,
    assignmentIds,
  };
}

/**
 * Assignments to Notion page properties
 * @param assignment Convert assignment to a Notion page's properties
 * @returns The properties of a Notion page
 */
function assignmentToNewPage(assignment: Assignment) {
  return {
    Name: {
      title: [
        {
          text: {
            content: assignment.name ?? "Untitled",
          },
        },
      ],
    },
    "Due Date": {
      date: {
        start: assignment.due_at ?? new Date().toISOString(),
      },
    },
    "Assignment Id": { number: assignment.id as number },
    "Subject Id": {
      rich_text: [{ text: { content: `${assignment.course_id ?? 0}` } }],
    },
    "Assignment URL": {
      url: assignment.html_url ?? null,
      // url: assignment.html_url ?? null,
    }
  } satisfies CreatePageParameters["properties"];
}

function assignmentToUpdatedPage(assignment: Assignment & { pageId: string }) {
  return {
    page_id: assignment.pageId,
    properties: {
      "Due Date": {
        date: {
          start: assignment.due_at ?? new Date().toISOString(),
        },
      },
      "Assignment URL": {
        url: assignment.html_url ?? null,
      }
    },
  } satisfies UpdatePageParameters;
}

async function getCourses() {
  const courses = await canvas.courses.listYourCourses();

  const selectedCourses = (await inquirer.prompt([
    {
      type: "checkbox",
      name: "courses",
      message: "Which courses would you like to add assessments from?",
      choices: courses.map((course) => ({
        name: course.name,
        value: course.id,
      })),
    },
  ])) as { courses: string[] };

  return selectedCourses.courses;
}

/**
 * Get all assignments for a list of courses
 * @param courses An array of course ids
 * @returns An array of assignments for each course
 * @throws {ApiError} If the request fails
 */
async function getAssignments(courses: string[]) {
  const courseAssignments = await Promise.all(
    courses.map((course) =>
      canvas.assignments.listAssignmentsAssignments(course)
    )
  );
  return courseAssignments.flat();
}

/**
 * Create a new database to add assessments to
 * @returns The id of the database to add assessments to
 * @throws {NotionClientError}
 */
async function newDb() {
  const parentPage = await getPage()

  const {dbName} = (await inquirer.prompt([
    {
      type: "input",
      name: "dbName",
      message: "What would you like to name the database?",
    },
  ])) as { dbName: string };


  const newDatabase = await notion.databases.create({
    parent: {
      type: "page_id",
      page_id: parentPage,
    },
    title: [
      {
        type: "text",
        text: {
          content: dbName,
        },
      },
    ],
    properties: {
      Name: {
        title: {},
      },
      "Due Date": {
        date: {},
      },
      "Assignment Id": {
        number: {},
      },
      "Subject Id": {
        rich_text: {},
      },
      "Assignment URL": {
        // url: {},
        url: {}
      }
    },
  });
  return newDatabase.id;
}

async function getPage() {
  const searchQuery = (await inquirer.prompt([
    {
      type: "input",
      name: "searchQuery",
      message: "What would you like to search for?",
    },
  ])) as { searchQuery: string };

  const pages = await notion.search({
    query: searchQuery.searchQuery,
    filter: {
      value: "page",
      property: "object",
    },
  });

  const onlyPages = pages.results.filter(
    (result) => result.object === "page"
  ) as PageObjectResponse[];

  const options = onlyPages
    .map((result) => {
      const name = result.properties.Name ?? result.properties.title;
      const isTitle = name?.type === "title";
      const title = isTitle ? name.title[0].plain_text : "Untitled";

      if (!isTitle) {
        logger.debug("Page does not have a title", {
          page: result,
        })
      }

      return {
        name: title,
        value: result.id,
      };
    })

  const selectedPage = (await inquirer.prompt([
    {
      type: "list",
      name: "selectedPage",
      message: "Which page would you like to add the database to?",
      choices: options,
    },
  ])) as { selectedPage: string };

  return selectedPage.selectedPage;

}

/**
 * Gets the id of the database to add assessments to through searching for it if it exists or creating a new one if it doesn't
 * @returns The id of the database to add assessments to
 */
async function getDatabase() {
  const dbName: { dbName: string } = await inquirer.prompt([
    {
      type: "input",
      name: "dbName",
      message:
        "What is the name of the database you add canvas assessments to?",
    },
  ]);

  const databases = await notion.search({
    query: dbName.dbName,
    filter: {
      value: "database",
      property: "object",
    },
  });

  const onlyDb = databases.results.filter(
    (result) => result.object === "database"
  ) as DatabaseObjectResponse[];

  const options = onlyDb
    .map((result) => ({ name: result.title[0].plain_text, value: result.id }))
    .concat({ name: "Create new database", value: "new" });

  const databaseId: { database: string } = await inquirer.prompt([
    {
      type: "list",
      name: "database",
      message: "Which database would you like to add the assessment to?",
      choices: options,
    },
  ]);

  if (databaseId.database !== "new") {
    return databaseId.database;
  } else {
    return await newDb();
  }
}

export async function getNotionKey () {
  const envPaths = await import("env-paths")
  const paths = envPaths.default("notion-canvas-sync")
  const fs = await import("fs")
  const path = await import("path")

  const keyPath = path.join(paths.config, "notion.key")

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, "utf8")
  }

  const key = (await inquirer.prompt([
    {
      type: "input",
      name: "key",
      message: "What is your Notion API key?",
    },
  ])) as { key: string };

  fs.writeFileSync(keyPath, key.key, "utf8")

  return key.key
}

export async function getCanvasKey () {
  const envPaths = await import("env-paths")
  const paths = envPaths.default("notion-canvas-sync")
  const fs = await import("fs")
  const path = await import("path")

  const keyPath = path.join(paths.config, "canvas.key")

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, "utf8")
  }

  const key = (await inquirer.prompt([
    {
      type: "input",
      name: "key",
      message: "What is your Canvas API key?",
    },
  ])) as { key: string };

  fs.mkdirSync(paths.config, { recursive: true })

  fs.writeFileSync(keyPath, key.key, "utf8")

  return key.key
}

export async function getCanvasUrl () {
  const envPaths = await import("env-paths")
  const paths = envPaths.default("notion-canvas-sync")
  const fs = await import("fs")
  const path = await import("path")

  const keyPath = path.join(paths.config, "canvas.url")

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, "utf8")
  }

  const key = (await inquirer.prompt([
    {
      type: "input",
      name: "key",
      message: "What is your Canvas URL?",
    },
  ])) as { key: string };

  fs.mkdirSync(paths.config, { recursive: true })

  fs.writeFileSync(keyPath, key.key, "utf8")

  return key.key
}