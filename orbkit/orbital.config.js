export default {
  deployment: {
    network: "devnet",
    out: "deployment",
    build: true,
    concurrency: 2,
    migrations: "latest-only"
  },
  contracts: [],
  rules: {
    unique: true
  }
};
