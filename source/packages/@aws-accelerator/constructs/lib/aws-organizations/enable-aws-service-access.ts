/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
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

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

const path = require('path');

/**
 * EnableAwsServiceAccessProps properties
 */
export interface EnableAwsServiceAccessProps {
  readonly servicePrincipal: string;
}

/**
 * Class to Enable AWS Service Access
 */
export class EnableAwsServiceAccess extends Construct {
  public readonly id: string;

  constructor(scope: Construct, id: string, props: EnableAwsServiceAccessProps) {
    super(scope, id);

    const customResource = cdk.CustomResourceProvider.getOrCreateProvider(
      this,
      'Custom::OrganizationsEnableAwsServiceAccess',
      {
        codeDirectory: path.join(__dirname, 'enable-aws-service-access/dist'),
        runtime: cdk.CustomResourceProviderRuntime.NODEJS_14_X,
        policyStatements: [
          {
            Effect: 'Allow',
            Action: ['organizations:DisableAWSServiceAccess', 'organizations:EnableAwsServiceAccess'],
            Resource: '*',
          },
        ],
      },
    );

    const resource = new cdk.CustomResource(this, 'Resource', {
      resourceType: 'Custom::EnableAwsServiceAccess',
      serviceToken: customResource.serviceToken,
      properties: {
        partition: cdk.Aws.PARTITION,
        ...props,
      },
    });

    this.id = resource.ref;
  }
}
