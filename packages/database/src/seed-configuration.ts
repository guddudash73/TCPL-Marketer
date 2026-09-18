import { createPrismaClient } from "./client.ts";

const database = createPrismaClient();

async function seedConfiguration(): Promise<void> {
  const sector = await database.sector.upsert({
    where: { slug: "lidar" },
    create: {
      name: "LiDAR",
      slug: "lidar",
      description:
        "Light detection and ranging data acquisition and processing.",
      terminology: ["LiDAR", "point cloud", "laser scanning"],
      geographies: ["United States"],
      negativeTerms: ["consumer lidar", "automotive lidar sensor"],
      researchRules: {
        prefer: ["aerial survey", "mapping", "geospatial services"],
        evidenceRequired: true,
      },
    },
    update: {},
  });

  const capability = await database.serviceCapability.upsert({
    where: {
      sectorId_slug: { sectorId: sector.id, slug: "point-cloud-processing" },
    },
    create: {
      sectorId: sector.id,
      name: "Point Cloud Processing",
      slug: "point-cloud-processing",
      description: "Production processing of acquired LiDAR point-cloud data.",
      businessProblems: [
        "Large acquired data volumes create production backlogs",
        "Internal teams need elastic processing capacity",
      ],
      businessValue:
        "Reliable outsourced production capacity for survey and acquisition teams.",
      searchGuidance: {
        include: [
          "airborne lidar survey",
          "aerial mapping",
          "geospatial acquisition",
        ],
      },
      researchGuidance: {
        lookFor: ["LiDAR acquisition", "survey aircraft", "mapping contracts"],
      },
    },
    update: {},
  });

  for (const name of [
    "Classification",
    "DTM",
    "DSM",
    "Feature Extraction",
    "QA/QC",
  ]) {
    const slug = name
      .toLowerCase()
      .replaceAll("/", "-")
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "");
    await database.capabilityDeliverable.upsert({
      where: { capabilityId_slug: { capabilityId: capability.id, slug } },
      create: { capabilityId: capability.id, name, slug },
      update: {},
    });
  }

  await database.targetClientProfile.upsert({
    where: {
      capabilityId_slug: {
        capabilityId: capability.id,
        slug: "airborne-lidar-survey-company",
      },
    },
    create: {
      capabilityId: capability.id,
      name: "Airborne LiDAR Survey Company",
      slug: "airborne-lidar-survey-company",
      companyCharacteristics: {
        acquiresLidar: true,
        operatesSurveyPrograms: true,
      },
      geographies: ["United States"],
      positiveTerms: ["airborne LiDAR", "aerial survey", "geospatial mapping"],
      negativeTerms: ["sensor manufacturer", "consumer electronics"],
      typicalBusinessModel:
        "Acquires geospatial data for mapping and survey projects.",
      outsourcingCharacteristics:
        "May outsource processing when project volume exceeds internal production capacity.",
    },
    update: {},
  });

  const decisionMakers = [
    "LiDAR Production Manager",
    "Geospatial Operations Manager",
    "Mapping Manager",
    "Survey Operations Director",
    "COO",
    "Managing Director",
  ];
  for (const [index, title] of decisionMakers.entries()) {
    await database.decisionMakerProfile.upsert({
      where: { capabilityId_title: { capabilityId: capability.id, title } },
      create: {
        capabilityId: capability.id,
        title,
        priority: index + 1,
        seniorities: index < 4 ? ["manager", "director"] : ["c_suite", "owner"],
      },
      update: { priority: index + 1 },
    });
  }
}

try {
  await seedConfiguration();
  console.log("LiDAR configuration seed complete.");
} finally {
  await database.$disconnect();
}
