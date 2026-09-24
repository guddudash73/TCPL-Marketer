import OpenAI from "openai";

import { OpenAISearchAdapter } from "./openai-search.adapter.js";

if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_RESEARCH_MODEL) {
  throw new Error(
    "Set OPENAI_API_KEY and OPENAI_RESEARCH_MODEL in the local .env before running the controlled live search",
  );
}

const adapter = new OpenAISearchAdapter(
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
);
const context = {
  campaignId: "d011-controlled-live-check",
  sector: {
    name: "LiDAR services",
    description: "Geospatial data capture and processing services",
    terminology: ["LiDAR", "laser scanning", "point cloud"],
    negativeTerms: ["consumer electronics"],
  },
  capabilities: [
    {
      name: "LiDAR data processing",
      description: "Point-cloud classification and geospatial deliverables",
      businessProblems: ["survey processing capacity", "project backlog"],
      businessValue: "Flexible specialist delivery capacity",
      searchGuidance: null,
    },
  ],
  deliverables: [
    { name: "Classified point cloud", description: "LAS/LAZ deliverable" },
  ],
  targetProfiles: [
    {
      name: "US surveying and engineering firms",
      companyCharacteristics: null,
      positiveTerms: ["surveying", "geospatial", "mapping"],
      negativeTerms: [],
      typicalBusinessModel: "Project-based professional services",
      outsourcingCharacteristics: "Variable processing workload",
    },
  ],
  geography: { countries: ["United States"], states: [], cities: [] },
  employeeRange: { minimum: 10, maximum: 500 },
  targetLeadCount: 5,
};

const planning = await adapter.plan(context);
const discovery = await adapter.search({
  context,
  plan: planning.data,
  maximumResults: 5,
});

process.stdout.write(
  `${JSON.stringify({ planning, discovery }, null, 2)}\n`,
);
