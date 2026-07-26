import { NextResponse } from "next/server";

// This would connect to Notion API
// For now, return mock data

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = "1264208d-f768-4604-b4cb-09f4d6fd41e3"; // Max's Tasks DB

export async function GET() {
  try {
    if (!NOTION_API_KEY) {
      // Return mock data if no API key
      return NextResponse.json({
        tasks: [
          { id: "1", name: "Review Polymarket bot strategy", status: "In progress", priority: "High", category: "Research" },
          { id: "2", name: "Build Hermy HQ dashboard", status: "In progress", priority: "High", category: "Content" },
          { id: "3", name: "Daily brief automation", status: "Approved", priority: "Medium", category: "Admin" },
        ],
      });
    }

    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Status",
          status: {
            does_not_equal: "Done",
          },
        },
      }),
    });

    const data = await res.json();
    
    const tasks = data.results?.map((page: any) => ({
      id: page.id,
      name: page.properties.Name?.title?.[0]?.plain_text || "Untitled",
      status: page.properties.Status?.status?.name || "Not started",
      priority: page.properties.Priority?.select?.name || "",
      category: page.properties.Category?.select?.name || "",
      dueDate: page.properties["Due Date"]?.date?.start || null,
    })) || [];

    return NextResponse.json({ tasks });
  } catch (error) {
    console.error("Tasks API error:", error);
    return NextResponse.json({ error: "Failed to fetch tasks" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { name, status } = await req.json();
    
    if (!NOTION_API_KEY) {
      return NextResponse.json({ success: true, message: "Mock - would create task in Notion" });
    }

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: name } }] },
          Status: { status: { name: status || "Not started" } },
        },
      }),
    });

    const data = await res.json();
    return NextResponse.json({ success: true, task: data });
  } catch (error) {
    console.error("Create task error:", error);
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { id, status } = await req.json();
    
    if (!NOTION_API_KEY) {
      return NextResponse.json({ success: true, message: "Mock - would update task in Notion" });
    }

    const res = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          Status: { status: { name: status } },
        },
      }),
    });

    const data = await res.json();
    return NextResponse.json({ success: true, task: data });
  } catch (error) {
    console.error("Update task error:", error);
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }
}
