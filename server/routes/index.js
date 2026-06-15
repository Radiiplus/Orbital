import buildDeployRoutes from './build-deploy.js';
import contractRoutes from './contracts.js';
import fundingRoutes from './funding.js';
import healthRoutes from './health.js';
import graphqlRoutes from './graphql.js';
import networkRoutes from './network.js';
import orbkitRoutes from './orbkit.js';
import projectStructureRoutes from './project-structure.js';
import sessionRoutes from './session.js';
import walletRoutes from './wallets.js';

export default async function registerRoutes(fastify) {
  await fastify.register(graphqlRoutes);
  await fastify.register(contractRoutes);
  await fastify.register(buildDeployRoutes);
  await fastify.register(fundingRoutes);
  await fastify.register(projectStructureRoutes);
  await fastify.register(orbkitRoutes);
  await fastify.register(sessionRoutes);
  await fastify.register(walletRoutes);
  await fastify.register(networkRoutes);
  await fastify.register(healthRoutes);
}
