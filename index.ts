import iam = require('aws-cdk-lib/aws-iam');
import ec2 = require('aws-cdk-lib/aws-ec2');
import eks = require('aws-cdk-lib/aws-eks');
import ecr = require('aws-cdk-lib/aws-ecr');
import secretsmanager = require('aws-cdk-lib/aws-secretsmanager');
import cdk = require('aws-cdk-lib');

import { KubectlV27Layer } from '@aws-cdk/lambda-layer-kubectl-v27';

const clusterName = 'clusterName';
const autoscalerImageTag = 'v1.26.2';

class EKSCluster extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1️⃣ Create a new VPC for our cluster

    const vpc = new ec2.Vpc(this, clusterName + '-vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.115.0.0/16'),
      subnetConfiguration: [
        {
          subnetType: ec2.SubnetType.PUBLIC,
          name: 'Public',
          cidrMask: 24, 
        },
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          name: 'Private',
          cidrMask: 24,
        },
      ]
    });
    
    // 2️⃣ IAM role for our EC2 worker nodes

    const workerRole = new iam.Role(this, clusterName + '-eks-worker-role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      roleName: clusterName + '-eks-worker-role',
    });
    workerRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'));
    workerRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'));
    workerRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'));

    // 3️⃣ Make the cluster

    const cluster = new eks.Cluster(this, clusterName, {
      vpc: vpc,
      version: eks.KubernetesVersion.V1_27,
      clusterName,
      kubectlLayer: new KubectlV27Layer(this, 'kubectl'),
      defaultCapacity: 0
    });

    cluster.addHelmChart('nginx', {
      chart: 'ingress-nginx',
      repository: 'https://kubernetes.github.io/ingress-nginx',
      namespace: 'kube-system',
      release: 'nginx'
    });

    // 4️⃣ Add a managed nodegroup of graviton instances

    const nodeGroup = cluster.addNodegroupCapacity(clusterName + '-capacity', {
      nodeRole: workerRole,
      instanceTypes: [ new ec2.InstanceType('m7g.2xlarge') ],
      amiType: eks.NodegroupAmiType.AL2_ARM_64,
      minSize: 2,
      maxSize: 80,
    });

    // 5️⃣ Setup the autoscaler-deployment... adding a managed nodegroup sadly doesnt set this up for us :(

    const autoscalerPolicyStatement = new iam.PolicyStatement();
    autoscalerPolicyStatement.addResources('*');
    autoscalerPolicyStatement.addActions(
      'autoscaling:DescribeAutoScalingGroups',
      'autoscaling:DescribeAutoScalingInstances',
      'autoscaling:DescribeLaunchConfigurations',
      'autoscaling:DescribeTags',
      'autoscaling:SetDesiredCapacity',
      'autoscaling:TerminateInstanceInAutoScalingGroup',
      'ec2:DescribeLaunchTemplateVersions',
    );
    const autoscalerPolicy = new iam.Policy(this, 'cluster-autoscaler-policy', {
      policyName: clusterName + '-autoscaler-policy',
      statements: [autoscalerPolicyStatement],
    });
    autoscalerPolicy.attachToRole(nodeGroup.role);
    const autoscalerManifest = JSON
      .stringify(require('./autoscaler-manifest.json'))
      .replace(/__IMAGE_TAG__/g, autoscalerImageTag)
      .replace(/__CLUSTER_NAME__/g, clusterName);
    new eks.KubernetesManifest(this, clusterName + '-autoscaler-manifest', {
      cluster,
      manifest: JSON.parse(autoscalerManifest),
    });

    // 6️⃣ Make image container and auth the cluster to talk to it

    const repository = new ecr.Repository(this, clusterName + '-repo', { repositoryName: clusterName + '-repo' });
    repository.addLifecycleRule({ maxImageAge: cdk.Duration.days(4 * 365) });
    const user = new iam.User(this, clusterName + '-repo-user', {
      userName: clusterName + '-repo-user',
    });
    repository.grantPullPush(user);
    workerRole.addToPolicy(new iam.PolicyStatement({
      resources: [repository.repositoryArn],
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
        'ecr:GetAuthorizationToken'
      ],
    }));

    // 7️⃣ Grant user kubectl access

    user.addToPolicy(
      new iam.PolicyStatement(
        {
          effect: iam.Effect.ALLOW,
          actions: [
            'eks:AccessKubernetesApi',
            'eks:Describe*',
            'eks:List*',
          ],
          resources: [ cluster.clusterArn ],
        }
      )
    );
    cluster.awsAuth.addUserMapping(user, { groups: ['system:masters'] });

    // 8️⃣ Insert a secret for the user's credentials

    const accessKey = new iam.AccessKey(this, clusterName + '-repo-user-access-key', { user });

    new secretsmanager.Secret(this, clusterName + '-repo-user-access-key-secret', {
      secretName: clusterName + '-repo-user-access-key',
      secretStringValue: accessKey.secretAccessKey,
    });

    new cdk.CfnOutput(this, clusterName + '-repo-user-access-key-id', { value: accessKey.accessKeyId });

  }

}

const app = new cdk.App();
new EKSCluster(app, clusterName + '-cdk-deployment');
app.synth();