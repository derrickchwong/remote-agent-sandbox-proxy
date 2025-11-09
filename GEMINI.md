# Remote Agent Sandbox Proxy

This project is a Node.js-based HTTP proxy for routing requests to agent sandboxes running in Kubernetes. It is written in TypeScript and uses Express.js for the web server.

## Project Overview

The proxy allows external clients to communicate with agent sandboxes through a simple path-based routing system. It automatically discovers sandbox instances by watching Kubernetes for `Sandbox` custom resources. The proxy also provides a management API for creating, deleting, pausing, and resuming sandboxes.

### Key Technologies

*   **Node.js:** The runtime environment for the application.
*   **TypeScript:** The programming language used.
*   **Express.js:** A web application framework for Node.js.
*   **Kubernetes:** The container orchestration platform where the sandboxes run.
*   **Google Cloud Build:** Used for CI/CD to build and deploy the application.
*   **Google Cloud Storage:** Used for persistent storage for the sandboxes.

### Architecture

The proxy is designed to run as a Kubernetes service, exposed to the public via a LoadBalancer. It routes requests based on the URL path in the format `/{username}/{sandboxname}/*` to the corresponding sandbox service.

## Building and Running

The project is built and deployed using Google Cloud Build. The `cloudbuild.yaml` file defines the build and deployment pipeline.

### Local Development

To run the application locally for development, you can use the following npm scripts defined in `package.json`:

*   **`npm run build`**: Compiles the TypeScript code to JavaScript.
*   **`npm run start`**: Starts the application from the compiled JavaScript code.
*   **`npm run dev`**: Compiles the TypeScript code and starts the application.

### Deployment

The application is deployed to a GKE cluster using the `gcloud builds submit` command with a set of substitution variables defined in `cloudbuild.yaml`. See the `README.md` for detailed deployment instructions.

## Development Conventions

*   **Code Style:** The project uses TypeScript and follows standard Node.js conventions.
*   **Testing:** There are no explicit testing frameworks or scripts defined in the `package.json`.
*   **Dependencies:** Project dependencies are managed using `npm`.
