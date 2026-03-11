"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

type DockerInfo = {
  docker: boolean;
  image: boolean;
  imageName: string;
};

export function DockerStatus() {
  const [info, setInfo] = useState<DockerInfo | null>(null);

  useEffect(() => {
    fetch("/api/settings/docker")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) {
    return (
      <Card>
        <CardHeader className="py-3">
          <span className="font-medium">Docker</span>
        </CardHeader>
        <CardContent className="py-2 text-sm text-muted-foreground">
          Checking...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between">
        <span className="font-medium">Docker</span>
        <Badge variant={info.docker ? "default" : "destructive"}>
          {info.docker ? "Connected" : "Not Available"}
        </Badge>
      </CardHeader>
      <CardContent className="py-2 text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Agent image</span>
          <span>{info.image ? "Ready" : "Not built"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Image name</span>
          <span className="font-mono text-xs">{info.imageName}</span>
        </div>
      </CardContent>
    </Card>
  );
}
