/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { AcceleratorStage } from '@aws-accelerator/accelerator';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codecommit from '@aws-cdk/aws-codecommit';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as codepipeline_actions from '@aws-cdk/aws-codepipeline-actions';
import * as iam from '@aws-cdk/aws-iam';
import * as s3 from '@aws-cdk/aws-s3';
import * as cdk from '@aws-cdk/core';
import * as compliant_constructs from '@aws-compliant-constructs/compliant-constructs';
import * as config_repository from './config-repository';

/**
 *
 */
export interface AcceleratorPipelineProps {
  readonly sourceRepositoryName: string;
  readonly sourceBranchName: string;
}

/**
 * AWS Accelerator Pipeline Class, which creates the pipeline for AWS Landing zone
 */
export class AcceleratorPipeline extends cdk.Construct {
  private pipelineRole: iam.Role;
  private toolkitRole: iam.Role;
  private toolkitProject: codebuild.PipelineProject;
  private buildOutput: codepipeline.Artifact;
  private acceleratorRepoArtifact: codepipeline.Artifact;
  private configRepoArtifact: codepipeline.Artifact;

  constructor(scope: cdk.Construct, id: string, props: AcceleratorPipelineProps) {
    super(scope, id);

    const bucket = new compliant_constructs.SecureS3Bucket(this, 'SecureBucket', {
      s3BucketName: `aws-accelerator-pipeline-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      kmsAliasName: 'alias/accelerator/pipeline/s3',
      kmsDescription: 'AWS Accelerator Pipeline Bucket CMK',
    });

    // cfn_nag: Suppress warning related to the pipeline artifacts S3 bucket
    const cfnBucket = bucket.node.defaultChild?.node.defaultChild as s3.CfnBucket;
    cfnBucket.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W35',
            reason: 'S3 Bucket access logging is not enabled for the pipeline artifacts bucket.',
          },
        ],
      },
    };

    const configRepository = new config_repository.ConfigRepository(this, 'ConfigRepository', {
      repositoryName: 'accelerator-config',
      repositoryBranchName: 'main',
      description:
        'AWS Accelerator configuration repository, created and initialized with default config file by pipeline',
    });

    /**
     * Pipeline
     */
    this.pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });

    const pipeline = new codepipeline.Pipeline(this, 'Resource', {
      pipelineName: 'AWSAccelerator-Pipeline',
      artifactBucket: bucket.getS3Bucket(),
      role: this.pipelineRole,
    });

    // cfn_nag: Suppress warning related to high SPCM score
    const cfnPipelinePolicy = pipeline.role.node.findChild('DefaultPolicy').node.defaultChild as iam.CfnPolicy;
    cfnPipelinePolicy.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W76',
            reason: 'This policy is generated by CDK which can cause a high SPCM score.',
          },
        ],
      },
    };

    this.acceleratorRepoArtifact = new codepipeline.Artifact('Source');
    this.configRepoArtifact = new codepipeline.Artifact('Config');

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.CodeCommitSourceAction({
          actionName: 'Source',
          repository: codecommit.Repository.fromRepositoryName(this, 'SourceRepo', props.sourceRepositoryName),
          branch: props.sourceBranchName,
          output: this.acceleratorRepoArtifact,
          trigger: codepipeline_actions.CodeCommitTrigger.NONE,
        }),
        new codepipeline_actions.CodeCommitSourceAction({
          actionName: 'Configuration',
          repository: configRepository.getRepository(),
          branch: 'main',
          output: this.configRepoArtifact,
          trigger: codepipeline_actions.CodeCommitTrigger.NONE,
        }),
      ],
    });

    /**
     * Build Stage
     */
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: 'AWSAccelerator-BuildProject',
      role: buildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 14,
            },
          },
          build: {
            commands: ['cd source', 'yarn install', 'yarn lerna link', 'yarn build'],
          },
        },
        artifacts: {
          files: ['**/*'],
          'enable-symlinks': 'yes',
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true, // Allow access to the Docker daemon
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ACCELERATOR_NAME: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: 'aws-accelerator',
          },
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
    });

    this.buildOutput = new codepipeline.Artifact('Build');

    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build',
          project: buildProject,
          input: this.acceleratorRepoArtifact,
          outputs: [this.buildOutput],
          role: this.pipelineRole,
        }),
      ],
    });

    /**
     * Deploy Stage
     */
    this.toolkitRole = new iam.Role(this, 'ToolkitRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    this.toolkitProject = new codebuild.PipelineProject(this, 'ToolkitProject', {
      projectName: 'AWSAccelerator-ToolkitProject',
      role: this.toolkitRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 14,
            },
          },
          build: {
            commands: [
              'env',
              'cd source',
              'cd packages/@aws-accelerator/accelerator',
              'npx ts-node --transpile-only cdk.ts --require-approval never $CDK_OPTIONS --config-dir $CODEBUILD_SRC_DIR_Config',
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true, // Allow access to the Docker daemon
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          CDK_NEW_BOOTSTRAP: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '1',
          },
          ACCOUNT_ID: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: cdk.Aws.ACCOUNT_ID,
          },
          ACCELERATOR_NAME: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: 'aws-accelerator',
          },
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
    });

    pipeline.addStage({
      stageName: 'Bootstrap',
      // TODO: Remove need to define a stage (validate)
      actions: [this.createToolkitStage('Bootstrap', `bootstrap --partition ${cdk.Stack.of(this).partition}`)],
    });

    // /**
    //  * The Validate stage is used to verify that all prerequisites have been made and that the
    //  * Accelerator can be deployed into the environment
    //  */
    // pipeline.addStage({
    //   stageName: 'Validate',
    //   actions: [this.createToolkitStage('Validate', `deploy --stage ${AcceleratorStage.VALIDATE}`)],
    // });

    /**
     * The Logging stack establishes all the logging assets that are needed in
     * all the accounts and will configure:
     *
     * - An S3 Access Logs bucket for every region in every account
     * - The Central Logs bucket in the in the log-archive account
     *
     */
    pipeline.addStage({
      stageName: 'Logging',
      actions: [this.createToolkitStage('Logging', `deploy --stage ${AcceleratorStage.LOGGING}`)],
    });

    pipeline.addStage({
      stageName: 'Organization',
      actions: [this.createToolkitStage('Organizations', `deploy --stage ${AcceleratorStage.ORGANIZATIONS}`)],
    });

    pipeline.addStage({
      stageName: 'SecurityAudit',
      actions: [this.createToolkitStage('SecurityAudit', `deploy --stage ${AcceleratorStage['SECURITY-AUDIT']}`)],
    });

    // pipeline.addStage({
    //   stageName: 'Dependencies',
    //   actions: [this.createToolkitStage('Dependencies', `deploy --stage ${AcceleratorStage.DEPENDENCIES}`)],
    // });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        this.createToolkitStage('Security', `deploy --stage ${AcceleratorStage.SECURITY}`, 1),
        // this.createToolkitStage('Networking', `deploy --stage ${AcceleratorStage.NETWORKING}`, 2),
        // this.createToolkitStage('Operations', `deploy --stage ${AcceleratorStage.OPERATIONS}`, 3),
      ],
    });
  }

  private createToolkitStage(
    actionName: string,
    cdkOptions: string,
    runOrder?: number,
  ): codepipeline_actions.CodeBuildAction {
    return new codepipeline_actions.CodeBuildAction({
      actionName,
      runOrder,
      project: this.toolkitProject,
      input: this.buildOutput,
      extraInputs: [this.configRepoArtifact],
      role: this.pipelineRole,
      environmentVariables: {
        CDK_OPTIONS: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: cdkOptions,
        },
      },
    });
  }
}
