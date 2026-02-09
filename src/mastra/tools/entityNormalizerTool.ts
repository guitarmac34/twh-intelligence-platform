import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Canonical dictionaries with aliases for healthcare IT entities
const ORGANIZATION_ALIASES: Record<string, string> = {
  // Vendors
  "cerner": "Oracle Health",
  "cerner corporation": "Oracle Health",
  "oracle cerner": "Oracle Health",
  "epic systems": "Epic",
  "epic systems corporation": "Epic",
  "microsoft corporation": "Microsoft",
  "google health": "Google",
  "google cloud": "Google",
  "amazon web services": "AWS",
  "amazon": "AWS",
  "ibm watson health": "IBM",
  "ibm watson": "IBM",
  "meditech": "MEDITECH",
  "allscripts": "Veradigm",
  "allscripts healthcare": "Veradigm",
  
  // Health Systems
  "hca healthcare": "HCA",
  "hca hospitals": "HCA",
  "commonspirit health": "CommonSpirit",
  "ascension health": "Ascension",
  "kaiser permanente": "Kaiser",
  "kaiser foundation": "Kaiser",
  "intermountain healthcare": "Intermountain",
  "intermountain health": "Intermountain",
  "cleveland clinic foundation": "Cleveland Clinic",
  "mayo clinic hospital": "Mayo Clinic",
  "johns hopkins medicine": "Johns Hopkins",
  "johns hopkins hospital": "Johns Hopkins",
  
  // Government/Agencies
  "office of the national coordinator": "ONC",
  "office of national coordinator": "ONC",
  "centers for medicare and medicaid services": "CMS",
  "centers for medicare & medicaid services": "CMS",
  "department of health and human services": "HHS",
  "hhs": "HHS",
  "food and drug administration": "FDA",
  "veterans affairs": "VA",
  "veterans health administration": "VA",
};

const TECHNOLOGY_ALIASES: Record<string, string> = {
  "epic cosmos": "Cosmos",
  "epic mychart": "MyChart",
  "cerner millennium": "Millennium",
  "oracle health millennium": "Millennium",
  "fast healthcare interoperability resources": "FHIR",
  "health level seven": "HL7",
  "health level 7": "HL7",
  "electronic health record": "EHR",
  "electronic medical record": "EMR",
  "artificial intelligence": "AI",
  "machine learning": "ML",
  "natural language processing": "NLP",
  "clinical decision support": "CDS",
  "revenue cycle management": "RCM",
  "population health management": "PHM",
  "patient portal": "Patient Portal",
  "telehealth platform": "Telehealth",
  "telemedicine": "Telehealth",
  "virtual care": "Telehealth",
};

export const entityNormalizerTool = createTool({
  id: "entity-normalizer",
  description:
    "Normalizes extracted entities using canonical dictionaries and alias mapping. Ensures consistent naming across the database.",

  inputSchema: z.object({
    organizations: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        confidence: z.number(),
      })
    ),
    people: z.array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        organization: z.string().optional(),
        confidence: z.number(),
      })
    ),
    technologies: z.array(
      z.object({
        name: z.string(),
        category: z.string(),
        vendor: z.string().optional(),
        confidence: z.number(),
      })
    ),
  }),

  outputSchema: z.object({
    organizations: z.array(
      z.object({
        canonicalName: z.string(),
        originalName: z.string(),
        type: z.string(),
        confidence: z.number(),
        wasNormalized: z.boolean(),
      })
    ),
    people: z.array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        organization: z.string().optional(),
        confidence: z.number(),
      })
    ),
    technologies: z.array(
      z.object({
        canonicalName: z.string(),
        originalName: z.string(),
        category: z.string(),
        vendor: z.string().optional(),
        confidence: z.number(),
        wasNormalized: z.boolean(),
      })
    ),
    success: z.boolean(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [entityNormalizerTool] Normalizing entities", {
      orgs: context.organizations.length,
      people: context.people.length,
      tech: context.technologies.length,
    });

    // Normalize organizations
    const normalizedOrgs = context.organizations.map((org) => {
      const lowerName = org.name.toLowerCase().trim();
      const canonical = ORGANIZATION_ALIASES[lowerName];
      
      return {
        canonicalName: canonical || org.name,
        originalName: org.name,
        type: org.type,
        confidence: org.confidence,
        wasNormalized: !!canonical,
      };
    });

    // Normalize people (just clean up names, normalize org references)
    const normalizedPeople = context.people.map((person) => {
      let normalizedOrg = person.organization;
      if (normalizedOrg) {
        const lowerOrg = normalizedOrg.toLowerCase().trim();
        normalizedOrg = ORGANIZATION_ALIASES[lowerOrg] || normalizedOrg;
      }
      
      return {
        name: person.name.trim(),
        title: person.title?.trim(),
        organization: normalizedOrg,
        confidence: person.confidence,
      };
    });

    // Normalize technologies
    const normalizedTech = context.technologies.map((tech) => {
      const lowerName = tech.name.toLowerCase().trim();
      const canonical = TECHNOLOGY_ALIASES[lowerName];
      
      let normalizedVendor = tech.vendor;
      if (normalizedVendor) {
        const lowerVendor = normalizedVendor.toLowerCase().trim();
        normalizedVendor = ORGANIZATION_ALIASES[lowerVendor] || normalizedVendor;
      }
      
      return {
        canonicalName: canonical || tech.name,
        originalName: tech.name,
        category: tech.category,
        vendor: normalizedVendor,
        confidence: tech.confidence,
        wasNormalized: !!canonical,
      };
    });

    // Remove duplicates after normalization
    const uniqueOrgs = normalizedOrgs.filter(
      (org, index, self) =>
        index === self.findIndex((o) => o.canonicalName === org.canonicalName)
    );

    const uniqueTech = normalizedTech.filter(
      (tech, index, self) =>
        index === self.findIndex((t) => t.canonicalName === tech.canonicalName)
    );

    logger?.info("✅ [entityNormalizerTool] Normalization complete", {
      orgsNormalized: uniqueOrgs.filter((o) => o.wasNormalized).length,
      techNormalized: uniqueTech.filter((t) => t.wasNormalized).length,
    });

    return {
      organizations: uniqueOrgs,
      people: normalizedPeople,
      technologies: uniqueTech,
      success: true,
    };
  },
});
